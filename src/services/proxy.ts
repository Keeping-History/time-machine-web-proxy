import { promises as fs } from "node:fs";
import type IORedis from "ioredis";
import type pino from "pino";
import type { ArchiveJobClientPort, JobProgressListener } from "../clients/archive-job-client";
import { windowAround } from "../lib/archive-time";
import { cachedCdxFetch } from "../lib/cdx-cache";
import type { DirectClient } from "../lib/dependencies";
import { describeFetchError, errorHasStatus } from "../lib/errors";
import { extractCdnEmbeddedUrl } from "../lib/redirect-unwrapper";
import { inlineCssLinks, rewriteCssUrls, rewriteHtmlUrls, stripWaybackToolbar } from "../lib/url-rewriter";
import { isHostnameWhitelisted } from "../lib/url-validator";
import type { Config } from "../models/config";
import type { ProxyResult } from "../models/proxy";
import type { CacheService } from "./cache";

// 30s — matches AVAILABILITY_TIMEOUT_MS in the worker. Production logs show
// sporadic 10s connect timeouts against web.archive.org; widening here keeps
// the size-preflight from misclassifying transient slowness as "skip crawl".
const CDX_TIMEOUT_MS = 30_000;
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
			| "crawlMaxCdxPages"
			| "crawlWindowDays"
			| "crawlMaxChunkFanout"
			| "bullmqPrefix"
			| "domainCrawlEnabled"
			| "cdxCacheEnabled"
			| "lockTime"
			| "proxyBase"
			| "prewarmEnabled"
			| "prewarmMaxAssetsPerPage"
		>,
		private readonly redis: IORedis | null = null,
		private readonly directClient: DirectClient | null = null,
	) {}

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
				const fallback = extractCdnEmbeddedUrl(targetUrl);
				if (fallback) {
					this.logger.info(
						{ targetUrl, fallback, time },
						"[cdn-fallback] CDN URL not in archive, retrying with embedded origin URL",
					);
					return this.fetchCore(fallback, time, onProgress);
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
		let hit = await this.cache.lookup(targetUrl, time);
		let cacheStatus: "HIT" | "MISS_DIRECT" | "MISS_WORKER" = "HIT";

		if (!hit) {
			// Tier 2: direct fetch (fast path)
			if (this.directClient) {
				const direct = await this.directClient.fetchAtRequestedTime(targetUrl, time);
				if (direct.outcome === "ok" && direct.body) {
					await this.cache.writeFile(targetUrl, time, direct.body);
					if (direct.resolvedTime) {
						await this.cache.writeResolvedTimeSidecar(time, targetUrl, direct.resolvedTime);
					}
					if (direct.contentType) {
						await this.cache.writeContentTypeSidecar(targetUrl, time, direct.contentType);
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

		const raw = await fs.readFile(hit.absPath);
		const isHtml = hit.contentType.startsWith("text/html");
		const isCss = hit.contentType.startsWith("text/css");
		let body: string | Buffer = raw;

		if (isHtml) {
			const stripped = stripWaybackToolbar(raw.toString("utf-8"));
			const { html, discoveredAssets } = rewriteHtmlUrls(
				stripped,
				targetUrl,
				time,
				this.config.lockTime,
				this.config.proxyBase,
			);
			body = await inlineCssLinks(
				html,
				this.buildCssFetcher(),
				time,
				this.config.lockTime,
				this.config.proxyBase,
			);
			this.logger.debug({ targetUrl, time }, "[inline-css] stylesheet inlining complete");

			// Tier 1 (prewarm): fire-and-forget prefetch of discovered assets.
			// Errors are swallowed so prewarm failures never affect the foreground response.
			if (this.config.prewarmEnabled && this.directClient && discoveredAssets.length > 0) {
				const assetsToPrewarm = discoveredAssets.slice(0, this.config.prewarmMaxAssetsPerPage);
				for (const asset of assetsToPrewarm) {
					const p = this.directClient
						.fetchAtResolvedTime(asset.url, asset.embeddedTs)
						.then(async (result) => {
							if (result.outcome === "ok" && result.body) {
								await this.cache.writeFile(asset.url, asset.embeddedTs, result.body);
								if (result.contentType) {
									await this.cache.writeContentTypeSidecar(
										asset.url,
										asset.embeddedTs,
										result.contentType,
									);
								}
							}
						})
						.catch((err: unknown) => {
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
		} else if (isCss) {
			body = rewriteCssUrls(raw.toString("utf-8"), targetUrl, time, this.config.lockTime, undefined, undefined, this.config.proxyBase);
		}

		return {
			contentType: hit.contentType,
			archiveUrl: targetUrl,
			originalUrl: targetUrl,
			archiveTime: hit.archiveTime ?? time,
			body,
			cache: cacheStatus,
		};
	}

	private buildCssFetcher(): (cssUrl: string, ts: string) => Promise<string | null> {
		return async (cssUrl: string, ts: string): Promise<string | null> => {
			let body: Buffer | null = null;
			try {
				const hit = await this.cache.lookup(cssUrl, ts);
				if (hit) {
					const raw = await fs.readFile(hit.absPath);
					return raw.toString("utf-8");
				}
				if (!this.directClient) return null;
				const result = await this.directClient.fetchAtRequestedTime(cssUrl, ts);
				if (result.outcome !== "ok" || !result.body) return null;
				body = result.body;
				try {
					await this.cache.writeFile(cssUrl, ts, result.body);
					await this.cache.writeContentTypeSidecar(cssUrl, ts, result.contentType ?? "text/css");
					if (result.resolvedTime) {
						await this.cache.writeResolvedTimeSidecar(ts, cssUrl, result.resolvedTime);
					}
				} catch (err) {
					this.logger.warn({ cssUrl, ts, err }, "[proxy] CSS cache write error");
				}
				return body.toString("utf-8");
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

			const pages = await this.cdxPageCount(host, time);
			if (pages === 0) {
				this.logger.debug({ host }, "[crawl-skip] 0 CDX pages in window");
				return;
			}
			const cappedPages = Math.min(pages, this.config.crawlMaxCdxPages);
			this.logger.info({ host, time, pages, cappedPages }, "[crawl] fan-out");
			await this.archiveJobClient.enqueueDomainCrawl(host, time);
			await this.archiveJobClient.enqueueCrawlChunks(
				host,
				time,
				cappedPages,
				this.config.crawlMaxChunkFanout,
			);
		} catch (e) {
			this.logger.warn(
				{ host, err: e instanceof Error ? e : new Error(String(e)) },
				"[crawl-skip] enqueue failed",
			);
		}
	}

	/**
	 * Explicit (admin-triggered) domain crawl. Unlike `maybeEnqueueDomainCrawl`,
	 * this:
	 *   - Throws status errors instead of swallowing them — the caller is an
	 *     HTTP endpoint that needs a concrete response code.
	 *   - Bypasses the per-host 24h Redis budget. The budget exists to throttle
	 *     fire-and-forget side-effects of foreground requests; an explicit admin
	 *     action shouldn't inherit that throttle.
	 *   - STILL enforces the whitelist — that's a security boundary, not a rate-limit.
	 *   - STILL respects `DOMAIN_CRAWL_ENABLED` as the kill switch.
	 *
	 * `opts.skipPreflight` — when true, skips the CDX page-count cap check. Useful
	 * when archive.org is rejecting/timing-out CDX requests from your egress IP
	 * but the downloader path still works. Trade-off: you lose the runaway-crawl
	 * guard, so the admin must know the target host's size or risk a multi-hour
	 * download. Always opt-in; never on by default.
	 */
	async triggerDomainCrawl(
		host: string,
		time: string,
		opts: { skipPreflight?: boolean } = {},
	): Promise<void> {
		if (!this.config.domainCrawlEnabled) {
			throw statusError("Domain crawl is disabled (DOMAIN_CRAWL_ENABLED=false)", 503);
		}
		if (!isHostnameWhitelisted(host, this.config.whitelistHosts)) {
			throw statusError("Host not whitelisted", 403);
		}
		if (opts.skipPreflight) {
			this.logger.warn(
				{ host, time },
				"[crawl] preflight SKIPPED by admin — runaway-crawl guard disabled for this request",
			);
			await this.archiveJobClient.enqueueDomainCrawl(host, time);
			// Without a CDX page-count, fanout serves as both the total-pages
			// estimate and the cap — Math.min(fanout, fanout) is intentional.
			const fanout = this.config.crawlMaxChunkFanout;
			await this.archiveJobClient.enqueueCrawlChunks(host, time, fanout, fanout);
		} else {
			const pages = await this.cdxPageCount(host, time);
			if (pages === 0) {
				throw statusError("No CDX captures in window (0 pages)", 422);
			}
			this.logger.info({ host, time, pages }, "[crawl] explicit enqueue (preflight ok)");
			await this.archiveJobClient.enqueueDomainCrawl(host, time);
			await this.archiveJobClient.enqueueCrawlChunks(
				host,
				time,
				pages,
				this.config.crawlMaxChunkFanout,
			);
		}
	}

	private async cdxPageCount(host: string, time: string): Promise<number> {
		const { from, to } = windowAround(time, this.config.crawlWindowDays);
		// output=json is required so showNumPages counts pages in the same
		// pagination scheme the chunk worker uses. Without it, text-mode and
		// JSON-mode use different page sizes, causing too many chunk jobs to be
		// enqueued. CDX returns [["numpages"],["N"]] in this mode.
		const u =
			`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(`${host}/*`)}` +
			`&from=${from}&to=${to}&output=json&showNumPages=true`;
		const parsePageCount = (body: string): number => {
			const rows = JSON.parse(body) as unknown[][];
			const n = Number.parseInt(String(rows[1]?.[0] ?? ""), 10);
			if (Number.isNaN(n)) throw new Error("CDX page count is not a number");
			return n;
		};
		const isValidPageCount = (body: string): boolean => {
			try {
				return Number.isFinite(parsePageCount(body));
			} catch {
				return false;
			}
		};
		let r: Response;
		try {
			r = await cachedCdxFetch(
				u,
				{ signal: AbortSignal.timeout(CDX_TIMEOUT_MS) },
				{
					redis: this.redis,
					logger: this.logger,
					enabled: this.config.cdxCacheEnabled,
					bullmqPrefix: this.config.bullmqPrefix,
					validate: isValidPageCount,
				},
			);
		} catch (e) {
			// Node's fetch (undici) wraps the real failure in a generic
			// `TypeError: fetch failed` whose `.cause` holds the actual error
			// (DNS, ECONNREFUSED, TLS, AbortError on timeout, etc.). Surface it
			// so the caller (and the JSON error body on POST /crawl) shows the
			// reason, not just the wrapper.
			throw new Error(`CDX preflight network error: ${describeFetchError(e)}`, {
				cause: e,
			});
		}
		if (!r.ok) throw new Error(`CDX preflight ${r.status}`);
		const txt = (await r.text()).trim();
		let n: number;
		try {
			n = parsePageCount(txt);
		} catch {
			n = Number.NaN;
		}
		if (!Number.isFinite(n)) {
			this.logger.warn(
				{ host, body: txt.slice(0, 80) },
				"[proxy] CDX page-count parse failed — response was not an integer",
			);
			throw new Error(`CDX page count indeterminate: ${txt.slice(0, 80)}`);
		}
		return n;
	}
}
