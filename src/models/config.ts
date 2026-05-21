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
	outboundProxyUrl: string;
	outboundProxyUsername: string;
	outboundProxyPassword: string;

	// — Snapshot timestamp resolver —
	snapshotWindowDays: number[];
	allowLaterFallback: boolean;
}
