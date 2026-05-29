export interface Config {
	// — existing, retained —
	port: number;
	hostname: string;
	defaultTime: string;
	cacheDir: string;
	cacheEnabled: boolean;
	allowedOrigins: string[];
	whitelistHosts: string;
	proxyPrefix: string;
	proxyBase: string;
	proxyBaseHostname: string;
	cacheClearToken: string;
	wsKeepaliveMs: number;

	// — Redis/BullMQ/worker/downloader/outbound-proxy —
	redisUrl: string;
	bullmqPrefix: string;
	domainCrawlEnabled: boolean;
	workerConcurrency: number;
	workerRateLimitPerSec: number;
	downloaderThreadsCount: number;
	crawlMaxCdxPages: number;
	outboundProxyUrls: string[];
	outboundProxyChooser: OutboundProxyChooser;
	outboundProxyUsername: string;
	outboundProxyPassword: string;
	/** Base cooldown applied to a proxy after a failure, in milliseconds.
	 * Parsed from OUTBOUND_PROXY_COOLDOWN_SECONDS (default 60s).
	 * Each consecutive re-probe failure extends the cooldown linearly by
	 * this base value (X, 2X, 3X, ...). */
	outboundProxyCooldownMs: number;

	// — Snapshot timestamp resolver —
	snapshotWindowDays: number[];
	/** Bidirectional ("closest snapshot") resolution for DIRECT/top-level URLs.
	 *  Off by default: a user who typed a time wants the page state at that
	 *  time, not a drifted later capture. Env: ALLOW_LATER_FALLBACK. */
	allowLaterFallback: boolean;
	/** Bidirectional resolution for ASSET URLs (images, CSS, JS, fonts, media).
	 *  On by default: assets rarely line up at the page's exact requested
	 *  timestamp, and serving the closest capture matches web.archive.org's
	 *  own behavior for sub-resources. Env: ASSET_LATER_FALLBACK. */
	assetLaterFallback: boolean;

	// — Direct-fetch kill switches and tuning knobs —
	/** Master switch for direct Wayback asset fetching. Env: DIRECT_FETCH_ENABLED (default true). */
	directFetchEnabled: boolean;
	/** Max simultaneous direct fetch connections. Env: DIRECT_FETCH_MAX_CONCURRENT (default 10, 1-50). */
	directFetchMaxConcurrent: number;
	/** Per-fetch timeout in ms. Env: DIRECT_FETCH_TIMEOUT_MS (default 15000, 1000-60000). */
	directFetchTimeoutMs: number;
	/** Sustained rate cap in requests/sec for direct fetches. Env: DIRECT_FETCH_RATE_PER_SEC (default 20, 1-100). */
	directFetchRatePerSec: number;
	/** Burst allowance above the sustained rate. Env: DIRECT_FETCH_BURST (default 30, 1-200). */
	directFetchBurst: number;

	// — Prewarm knobs —
	/** Whether to prewarm asset URLs discovered during crawl. Env: PREWARM_ENABLED (default true). */
	prewarmEnabled: boolean;
	/** Max asset URLs to prewarm per page. Env: PREWARM_MAX_ASSETS_PER_PAGE (default 100, 0-500). */
	prewarmMaxAssetsPerPage: number;

	// — CDX response cache —
	/** Cache CDX responses in Redis to dedupe snapshot-resolver and crawl-preflight calls.
	 *  Env: CDX_CACHE_ENABLED (default true). */
	cdxCacheEnabled: boolean;

	// — Sentinel TTL —
	/** Age in days after which a not-found sentinel is considered stale and deleted on next lookup.
	 *  Env: NOT_FOUND_TTL_DAYS (default 30, 1-3650). */
	notFoundTtlDays: number;
}

export type OutboundProxyChooser = "sequential" | "random";
