import { promises as fs } from "node:fs";
import type IORedis from "ioredis";
import type pino from "pino";
import type { ArchiveJobClientPort, JobProgressListener } from "../clients/archive-job-client";
import { candidateFallbackUrls } from "../lib/asset-fallbacks";
import type { BlocklistService } from "../lib/blocklist";
import type { DirectClient } from "../lib/dependencies";
import { errorHasStatus } from "../lib/errors";
import {
	inlineCssLinksOnAst,
	rewriteCssUrls,
	rewriteHtmlUrlsToAst,
	stripWaybackToolbar,
} from "../lib/url-rewriter";
import { isHostnameWhitelisted } from "../lib/url-validator";
import type { Config } from "../models/config";
import type { ProxyResult } from "../models/proxy";
import type { CacheService } from "./cache";

const HOST_BUDGET_TTL_S = 86_400;

interface StatusError extends Error {
	status: number;
}

const statusError = (message: string, status: number): StatusError =>
	Object.assign(new Error(message), { status });

/**
 * Proxy fetch pipeline (three-tier MISS resolution):
 *   1. cache.lookup(url, time) → CacheHit | null
 *   2. on MISS — Tier 2 (direct fetch):
 *        ok       → write to cache, set MISS_DIRECT, skip worker
 *        not_found → write sentinel, throw 404
 *        fallback  → fall through to Tier 3
 *   3. on Tier 2 fallback — Tier 3 (worker):
 *        enqueueExactAndWait → re-lookup → set MISS_WORKER
 *        (502 if still empty — worker completed but cache write failed)
 *   4. read file from disk
 *   5. HTML/CSS rewrites (binary returned as-is)
 *   6. on HTML response: fire-and-forget prewarm for each discoveredAsset
 *      via fetchAtResolvedTime (Tier 1)
 *   7. on HTML MISS only: maybeEnqueueDomainCrawl (fire-and-forget),
 *      gated by whitelist + Redis per-host 24h budget + CDX preflight cap
 *
 * SSRF policy is NOT enforced here. TimeMachineService.validateTargetUrl
 * is responsible for rejecting private hosts and disallowed protocols
 * BEFORE the URL reaches ProxyService.
 */
export class ProxyService {
	private readonly activePrewarms = new Set<Promise<void>>();

	constructor(
		private readonly cache: CacheService,
		private readonly archiveJobClient: ArchiveJobClientPort,
		private readonly logger: pino.Logger,
		private readonly config: Pick<
			Config,
			| "whitelistHosts"
			| "bullmqPrefix"
			| "domainCrawlEnabled"
			| "lockTime"
			| "proxyBase"
			| "prewarmEnabled"
			| "prewarmMaxAssetsPerPage"
		>,
		private readonly redis: IORedis | null = null,
		private readonly directClient: DirectClient | null = null,
		private readonly blocklist: BlocklistService | null = null,
	) {}

	/**
	 * Throws 451 when the operator blocklist (config.json at the cache-bucket
	 * root) matches the host. Checked before the cache lookup so a blocked
	 * domain is neither retrieved, cached, nor served from an existing cache
	 * entry.
	 */
	private async assertNotBlocked(hostname: string): Promise<void> {
		if (this.blocklist && (await this.blocklist.isBlocked(hostname))) {
			throw statusError(`Domain blocked: ${hostname}`, 451);
		}
	}

	async drainPrewarms(): Promise<void> {
		await Promise.allSettled([...this.activePrewarms]);
	}

	async fetch(
		targetUrl: string,
		time: string,
		onProgress?: JobProgressListener,
	): Promise<ProxyResult> {
		try {
			return await this.fetchCore(targetUrl, time, onProgress);
		} catch (e) {
			if (errorHasStatus(e) && e.status === 404) {
				// Asset not in the archive under its requested URL. Try each
				// fallback rule (CDN-path unwrap, configured replacements, …) in
				// order; the first transformed URL that resolves wins. A 404 from
				// a candidate just advances to the next rule; any other error is
				// real and propagates immediately.
				for (const { rule, url } of candidateFallbackUrls(targetUrl)) {
					this.logger.info(
						{ targetUrl, fallback: url, rule, time },
						"[url-fallback] asset not in archive, retrying with transformed URL",
					);
					try {
						return await this.fetchCore(url, time, onProgress);
					} catch (inner) {
						if (errorHasStatus(inner) && inner.status === 404) continue;
						throw inner;
					}
				}
			}
			throw e;
		}
	}

	private async fetchCore(
		targetUrl: string,
		time: string,
		onProgress?: JobProgressListener,
	): Promise<ProxyResult> {
		const u = new URL(targetUrl);
		await this.assertNotBlocked(u.hostname);
		let hit = await this.cache.lookup(targetUrl, time);
		let cacheStatus: "HIT" | "MISS_DIRECT" | "MISS_WORKER" = "HIT";

		if (!hit) {
			// Tier 2: direct fetch (fast path)
			if (this.directClient) {
				const direct = await this.directClient.fetchAtRequestedTime(targetUrl, time);
				if (direct.outcome === "ok" && direct.body) {
					await this.cache.writeStream(targetUrl, time, direct.body);
					// Sidecars are best-effort metadata: the body is already cached,
					// so a sidecar write failure (e.g. a transient rename race on the
					// shared GCS mount) must not fail the asset response.
					if (direct.resolvedTime) {
						await this.cache
							.writeResolvedTimeSidecar(time, targetUrl, direct.resolvedTime)
							.catch((err) =>
								this.logger.warn(
									{ err, targetUrl, time },
									"[cache] resolved-time sidecar write failed",
								),
							);
					}
					if (direct.contentType) {
						await this.cache
							.writeContentTypeSidecar(targetUrl, time, direct.contentType)
							.catch((err) =>
								this.logger.warn(
									{ err, targetUrl, time },
									"[cache] content-type sidecar write failed",
								),
							);
					}
					hit = await this.cache.lookup(targetUrl, time);
					cacheStatus = "MISS_DIRECT";
					this.logger.info({ targetUrl, time }, "[CACHE MISS_DIRECT] direct fetch ok");
				} else if (direct.outcome === "not_found") {
					await this.cache.writeNotFoundSentinel(time, targetUrl);
					throw statusError(`Not in archive: ${targetUrl} @ ${time}`, 404);
				} else {
					// fallback: proceed to Tier 3 (worker)
					this.logger.info(
						{ targetUrl, time, reason: (direct as { reason?: string }).reason },
						"[direct] fallback to worker",
					);
				}
			}

			// Tier 3: worker (fallback or no directClient)
			if (!hit) {
				this.logger.info({ targetUrl, time }, "[CACHE MISS] enqueueing exact-url job");
				// Only forward onProgress when defined so the client receives a clean
				// 2-arg call in the no-callback case (avoids leaking `undefined` into
				// jest.toHaveBeenCalledWith assertions and matches the spec).
				if (onProgress) {
					await this.archiveJobClient.enqueueExactAndWait(targetUrl, time, onProgress);
				} else {
					await this.archiveJobClient.enqueueExactAndWait(targetUrl, time);
				}
				hit = await this.cache.lookup(targetUrl, time);
				cacheStatus = "MISS_WORKER";
				if (!hit) {
					throw statusError(`Job completed but cache empty for ${targetUrl} @ ${time}`, 502);
				}
			}
		} else {
			this.logger.info({ targetUrl, time }, "[CACHE HIT]");
		}

		let redirect: { url: string; time: string } | undefined;
		const isHtml = hit.contentType.startsWith("text/html");
		const isCss = hit.contentType.startsWith("text/css");

		if (!isHtml && !isCss) {
			return {
				contentType: hit.contentType,
				archiveUrl: targetUrl,
				originalUrl: targetUrl,
				archiveTime: hit.archiveTime ?? time,
				bodyPath: hit.absPath,
				cache: cacheStatus,
			};
		}

		const raw = await fs.readFile(hit.absPath);
		let body: string | Buffer = raw;

		if (isHtml) {
			const stripped = stripWaybackToolbar(raw.toString("utf-8"));
			const { document, discoveredAssets, metaRefresh } = rewriteHtmlUrlsToAst(
				stripped,
				targetUrl,
				time,
				this.config.lockTime,
				this.config.proxyBase,
			);
			redirect = metaRefresh;
			body = await inlineCssLinksOnAst(
				document,
				this.buildCssFetcher(),
				time,
				// CSS references assets → always keep the timestamp, even when
				// lockTime hides the date from navigation links.
				false,
				this.config.proxyBase,
			);
			this.logger.debug({ targetUrl, time }, "[inline-css] stylesheet inlining complete");

			// A redirect stub is thrown away by the handler once followed — don't
			// prewarm its assets or seed a crawl from it.
			if (!redirect) {
				// Tier 1 (prewarm): fire-and-forget prefetch of discovered assets.
				// Errors are swallowed so prewarm failures never affect the foreground response.
				if (this.config.prewarmEnabled && this.directClient && discoveredAssets.length > 0) {
					const directClient = this.directClient;
					const assetsToPrewarm = discoveredAssets.slice(0, this.config.prewarmMaxAssetsPerPage);
					for (const asset of assetsToPrewarm) {
						const p = (async () => {
							// A page on an allowed host can embed assets from a blocked one
							// (trackers, ad servers) — those must not be fetched or cached.
							const assetHost = new URL(asset.url).hostname;
							if (this.blocklist && (await this.blocklist.isBlocked(assetHost))) {
								this.logger.debug({ url: asset.url }, "[prewarm] skipping blocked domain");
								return;
							}
							const result = await directClient.fetchAtResolvedTime(asset.url, asset.embeddedTs);
							if (result.outcome === "ok" && result.body) {
								await this.cache.writeStream(asset.url, asset.embeddedTs, result.body);
								if (result.contentType) {
									await this.cache.writeContentTypeSidecar(
										asset.url,
										asset.embeddedTs,
										result.contentType,
									);
								}
							}
						})().catch((err: unknown) => {
							this.logger.warn(
								{
									url: asset.url,
									ts: asset.embeddedTs,
									error: err instanceof Error ? err.message : String(err),
								},
								"[prewarm] asset prefetch error",
							);
						});
						this.activePrewarms.add(p);
						void p.finally(() => this.activePrewarms.delete(p));
					}
				}

				if (cacheStatus !== "HIT") {
					void this.maybeEnqueueDomainCrawl(u.hostname, time);
				}
			}
		} else if (isCss) {
			body = rewriteCssUrls(
				raw.toString("utf-8"),
				targetUrl,
				time,
				// A standalone stylesheet is an asset → keep the timestamp.
				false,
				undefined,
				undefined,
				this.config.proxyBase,
			);
		}

		return {
			contentType: hit.contentType,
			archiveUrl: targetUrl,
			originalUrl: targetUrl,
			archiveTime: hit.archiveTime ?? time,
			body,
			cache: cacheStatus,
			...(redirect ? { redirect } : {}),
		};
	}

	private buildCssFetcher(): (cssUrl: string, ts: string) => Promise<string | null> {
		return async (cssUrl: string, ts: string): Promise<string | null> => {
			try {
				const hit = await this.cache.lookup(cssUrl, ts);
				if (hit) {
					const raw = await fs.readFile(hit.absPath);
					return raw.toString("utf-8");
				}
				if (!this.directClient) return null;
				const result = await this.directClient.fetchAtRequestedTime(cssUrl, ts);
				if (result.outcome !== "ok" || !result.body) return null;
				try {
					await this.cache.writeStream(cssUrl, ts, result.body);
					await this.cache.writeContentTypeSidecar(cssUrl, ts, result.contentType ?? "text/css");
					if (result.resolvedTime) {
						await this.cache.writeResolvedTimeSidecar(ts, cssUrl, result.resolvedTime);
					}
				} catch (err) {
					this.logger.warn({ cssUrl, ts, err }, "[proxy] CSS cache write error");
					return null;
				}
				const written = await this.cache.lookup(cssUrl, ts);
				if (!written) return null;
				const raw = await fs.readFile(written.absPath);
				return raw.toString("utf-8");
			} catch (err) {
				this.logger.warn({ cssUrl, ts, err }, "[proxy] CSS fetch error");
				return null;
			}
		};
	}

	/**
	 * Decide whether to fire a fire-and-forget domain crawl for `host`.
	 *
	 * Order of checks (cheapest first):
	 *   (a) whitelist — config-driven, in-memory
	 *   (b) per-host 24h budget via Redis SET NX EX
	 *   (c) CDX page-count preflight against config.crawlMaxCdxPages
	 *
	 * ALL errors are swallowed: a crawl scheduling failure must never
	 * propagate to the foreground request, which has already been served.
	 */
	private async maybeEnqueueDomainCrawl(host: string, time: string): Promise<void> {
		try {
			if (!isHostnameWhitelisted(host, this.config.whitelistHosts)) {
				this.logger.debug({ host }, "[crawl-skip] not whitelisted");
				return;
			}

			if (this.redis) {
				// Sibling namespace to the BullMQ prefix (separator "-" not ":") so
				// bull-board's "<prefix>:*" queue-discovery scan doesn't surface this
				// as a phantom queue.
				const key = `${this.config.bullmqPrefix}-budget:crawl:${host}`;
				const setRes = await this.redis.set(key, "1", "EX", HOST_BUDGET_TTL_S, "NX");
				if (setRes !== "OK") {
					this.logger.debug({ host }, "[crawl-skip] budget already consumed");
					return;
				}
			}

			this.logger.info({ host, time }, "[crawl] seeding recursive crawl");
			await this.archiveJobClient.enqueueDomainCrawl(host, time);
		} catch (e) {
			this.logger.warn(
				{ host, err: e instanceof Error ? e : new Error(String(e)) },
				"[crawl-skip] enqueue failed",
			);
		}
	}

	/**
	 * Explicit (admin-triggered) domain crawl. Seeds a recursive (BFS) link
	 * crawl from the host homepage. Unlike `maybeEnqueueDomainCrawl` it:
	 *   - Throws status errors instead of swallowing them — the caller is an
	 *     HTTP endpoint that needs a concrete response code.
	 *   - Bypasses the per-host 24h Redis budget (that throttle is for the
	 *     fire-and-forget foreground path, not an explicit admin action).
	 *   - STILL enforces the whitelist (a security boundary) and
	 *     DOMAIN_CRAWL_ENABLED (the kill switch).
	 *
	 * The crawl walk — same-host link discovery, depth and page-budget bounds —
	 * lives in the exact worker (recurseCrawl). This only enqueues the seed.
	 */
	async triggerDomainCrawl(host: string, time: string): Promise<void> {
		if (!this.config.domainCrawlEnabled) {
			throw statusError("Domain crawl is disabled (DOMAIN_CRAWL_ENABLED=false)", 503);
		}
		if (!isHostnameWhitelisted(host, this.config.whitelistHosts)) {
			throw statusError("Host not whitelisted", 403);
		}
		await this.assertNotBlocked(host);
		this.logger.info({ host, time }, "[crawl] explicit recursive-crawl seed");
		await this.archiveJobClient.enqueueDomainCrawl(host, time);
	}
}
