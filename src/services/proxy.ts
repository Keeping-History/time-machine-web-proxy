import { promises as fs } from "node:fs";
import type IORedis from "ioredis";
import type pino from "pino";
import type { ArchiveJobClientPort } from "../clients/archive-job-client";
import { rewriteArchiveLinks, rewriteCssUrls, stripWaybackToolbar } from "../lib/url-rewriter";
import { isHostWhitelisted } from "../lib/url-validator";
import type { Config } from "../models/config";
import type { ProxyResult } from "../models/proxy";
import type { CacheService } from "./cache";

// 30s — matches AVAILABILITY_TIMEOUT_MS in the worker. Production logs show
// sporadic 10s connect timeouts against web.archive.org; widening here keeps
// the size-preflight from misclassifying transient slowness as "skip crawl".
const CDX_TIMEOUT_MS = 30_000;
const HOST_BUDGET_TTL_S = 86_400;
const HOST_BUDGET_KEY_PREFIX = "tm:crawl:budget:";

interface StatusError extends Error {
	status: number;
}

const statusError = (message: string, status: number): StatusError =>
	Object.assign(new Error(message), { status });

/**
 * Proxy fetch pipeline (post-TASK-009):
 *   1. cache.lookup(url, time) → CacheHit | null
 *   2. on MISS: archiveJobClient.enqueueExactAndWait → re-lookup
 *      (502 if still empty — worker completed but cache write failed)
 *   3. read file from disk
 *   4. HTML/CSS rewrites (binary returned as-is)
 *   5. on HTML MISS only: maybeEnqueueDomainCrawl (fire-and-forget),
 *      gated by whitelist + Redis per-host 24h budget + CDX preflight cap
 *
 * SSRF policy is NOT enforced here. TimeMachineService.validateTargetUrl
 * is responsible for rejecting private hosts and disallowed protocols
 * BEFORE the URL reaches ProxyService.
 */
export class ProxyService {
	constructor(
		private readonly cache: CacheService,
		private readonly archiveJobClient: ArchiveJobClientPort,
		private readonly logger: pino.Logger,
		private readonly config: Pick<Config, "proxyBase" | "whitelistHosts" | "crawlMaxCdxPages">,
		private readonly redis: IORedis | null = null,
	) {}

	async fetch(targetUrl: string, time: string): Promise<ProxyResult> {
		const u = new URL(targetUrl);
		let hit = await this.cache.lookup(targetUrl, time);
		let cacheStatus: "HIT" | "MISS" = "HIT";

		if (!hit) {
			this.logger.info({ targetUrl, time }, "[CACHE MISS] enqueueing exact-url job");
			await this.archiveJobClient.enqueueExactAndWait(targetUrl, time);
			hit = await this.cache.lookup(targetUrl, time);
			cacheStatus = "MISS";
			if (!hit) {
				throw statusError(`Job completed but cache empty for ${targetUrl} @ ${time}`, 502);
			}
		} else {
			this.logger.info({ targetUrl, time }, "[CACHE HIT]");
		}

		const raw = await fs.readFile(hit.absPath);
		const isHtml = hit.contentType.startsWith("text/html");
		const isCss = hit.contentType.startsWith("text/css");
		let body: string | Buffer = raw;

		if (isHtml) {
			const html = stripWaybackToolbar(raw.toString("utf-8"), targetUrl);
			body = rewriteArchiveLinks(
				rewriteCssUrls(html, this.config.proxyBase, time),
				this.config.proxyBase,
			);
			if (cacheStatus === "MISS") {
				void this.maybeEnqueueDomainCrawl(u.hostname, time);
			}
		} else if (isCss) {
			body = rewriteCssUrls(raw.toString("utf-8"), this.config.proxyBase, time);
		}

		return {
			contentType: hit.contentType,
			archiveUrl: targetUrl,
			originalUrl: targetUrl,
			archiveTime: time,
			body,
			cache: cacheStatus,
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
			if (!isHostWhitelisted(`https://${host}`, this.config.whitelistHosts)) {
				this.logger.debug({ host }, "[crawl-skip] not whitelisted");
				return;
			}

			if (this.redis) {
				const key = `${HOST_BUDGET_KEY_PREFIX}${host}`;
				const setRes = await this.redis.set(key, "1", "EX", HOST_BUDGET_TTL_S, "NX");
				if (setRes !== "OK") {
					this.logger.debug({ host }, "[crawl-skip] budget already consumed");
					return;
				}
			}

			const pages = await this.cdxPageCount(host, time);
			if (pages > this.config.crawlMaxCdxPages) {
				this.logger.warn(
					{ host, pages, cap: this.config.crawlMaxCdxPages },
					"[crawl-skip] too large",
				);
				return;
			}

			await this.archiveJobClient.enqueueDomainCrawl(host, time);
		} catch (e) {
			this.logger.warn(
				{ host, error: e instanceof Error ? e.message : String(e) },
				"[crawl-skip] enqueue failed",
			);
		}
	}

	private async cdxPageCount(host: string, time: string): Promise<number> {
		// Widen to the calendar day of `time` so CDX counts captures across the
		// day instead of the exact second (which virtually never matches and
		// would always yield 0, defeating the crawl-size cap).
		const day = time.slice(0, 8);
		const u =
			`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(`${host}/*`)}` +
			`&from=${day}000000&to=${day}235959&output=json&showNumPages=true`;
		const r = await fetch(u, { signal: AbortSignal.timeout(CDX_TIMEOUT_MS) });
		if (!r.ok) throw new Error(`CDX preflight ${r.status}`);
		const txt = (await r.text()).trim();
		const n = Number.parseInt(txt, 10);
		return Number.isFinite(n) ? n : 0;
	}
}
