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
}

export type OutboundProxyChooser = "sequential" | "random";
