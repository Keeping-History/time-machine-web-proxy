export interface Config {
	// — existing, retained —
	port: number;
	hostname: string;
	defaultTime: string;
	cacheDir: string;
	cacheEnabled: boolean;
	allowedOrigins: string[];
	whitelistHosts: string[];
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
	/** Recursive (BFS) crawl: max link depth to follow from the seed homepage
	 *  (seed is depth 0). Env: CRAWL_MAX_DEPTH (default 3, 1-20). */
	crawlMaxDepth: number;
	/** Recursive (BFS) crawl: max HTML pages to recurse into per crawl run
	 *  (caps load on archive.org). Env: CRAWL_MAX_PAGES (default 1000, 1-1000000). */
	crawlMaxPages: number;
	/** BullMQ priority assigned to exact jobs created by a domain crawl, so a
	 *  crawl backlog can't starve real-time requests (which run at top priority
	 *  1). Lower number = higher priority, so this must be > 1.
	 *  Env: CRAWL_JOB_PRIORITY (default 10, 2-2097152). */
	crawlJobPriority: number;
	outboundProxyUrls: string[];
	outboundProxyChooser: OutboundProxyChooser;
	outboundProxyUsername: string;
	outboundProxyPassword: string;
	/** Base cooldown applied to a proxy after a failure, in milliseconds.
	 * Parsed from OUTBOUND_PROXY_COOLDOWN_SECONDS (default 60s).
	 * Each consecutive re-probe failure extends the cooldown linearly by
	 * this base value (X, 2X, 3X, ...). */
	outboundProxyCooldownMs: number;

	// — Direct-fetch kill switches and tuning knobs —
	/** Master switch for direct Wayback asset fetching. Env: DIRECT_FETCH_ENABLED (default true). */
	directFetchEnabled: boolean;
	/** Max simultaneous direct fetch connections. Env: DIRECT_FETCH_MAX_CONCURRENT (default 10, 1-50). */
	directFetchMaxConcurrent: number;
	/** Per-fetch timeout in ms. Env: DIRECT_FETCH_TIMEOUT_MS (default 30000, 1000-60000). */
	directFetchTimeoutMs: number;
	/** Sustained rate cap in requests/sec for direct fetches. Env: DIRECT_FETCH_RATE_PER_SEC (default 20, 1-100). */
	directFetchRatePerSec: number;
	/** Burst allowance above the sustained rate. Env: DIRECT_FETCH_BURST (default 30, 1-200). */
	directFetchBurst: number;
	/** Max TCP connections in the direct-fetch pool. Env: DIRECT_FETCH_POOL_CONNECTIONS (default 5, 1-50). */
	directFetchPoolConnections: number;
	/** Idle keepalive timeout for direct-fetch pool sockets, ms. Env: DIRECT_FETCH_POOL_KEEPALIVE_MS (default 30000, 1000-300000). */
	directFetchPoolKeepaliveMs: number;
	/** Cap on concurrent HTTP/2 streams per TCP socket. Env: DIRECT_FETCH_POOL_MAX_STREAMS (default 10, 1-100). */
	directFetchPoolMaxConcurrentStreams: number;
	/** Advertise h2 in ALPN when negotiating with Wayback. Env: DIRECT_FETCH_HTTP2_ENABLED (default true). */
	directFetchHttp2Enabled: boolean;
	/** Initial cooldown after ECONNREFUSED opens the breaker, ms. Env: DIRECT_FETCH_BLOCKED_BASE_MS (default 5000, 1000-300000). */
	directFetchBlockedBaseMs: number;
	/** Maximum cooldown after consecutive HALF_OPEN probe failures, ms. Env: DIRECT_FETCH_BLOCKED_MAX_MS (default 600000, 1000-3600000). */
	directFetchBlockedMaxMs: number;

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

	// — URL rewriter behaviour —
	/** Hide the date from navigation links so browsing stays pinned to the
	 *  configured default era (ARCHIVE_TIME). Anchor/area href, form action,
	 *  frame/iframe src and meta-refresh become `/web/{url}` rather than
	 *  `/web/{ts}/{url}`, so they fall back to the default time. Asset URLs
	 *  (img/script/css/object/srcset/…) ALWAYS keep their timestamp so they
	 *  resolve to the exact captured snapshot. Applies to HTML responses and
	 *  the runtime shim. Env: LOCK_TIME (default false). */
	lockTime: boolean;

	// — Hostname normalizer —
	/** Explicit hostname rewrites applied before the Wayback Machine lookup.
	 *  Env: DOMAIN_REMAP (comma-separated `from=to` pairs, e.g.
	 *  `www.msnbc.com.edgesuite.net=www.msnbc.com`). Takes precedence over
	 *  CDN suffix stripping. */
	domainRemap: Record<string, string>;
}

export type OutboundProxyChooser = "sequential" | "random";
