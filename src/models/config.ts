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

	// — new (Redis/BullMQ/worker/downloader/outbound-proxy) —
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

	// — deprecated; removed in TASK-011 alongside WaybackClient/ArchiveRequestQueue —
	/** @deprecated removed in TASK-011 */
	archivePrefix: string;
	/** @deprecated removed in TASK-011 */
	archiveRatePerSec: number;
	/** @deprecated removed in TASK-011 */
	archiveBurst: number;
	/** @deprecated removed in TASK-011 */
	archiveMaxRetries: number;
	/** @deprecated removed in TASK-011 */
	archiveMaxConcurrent: number;
}
