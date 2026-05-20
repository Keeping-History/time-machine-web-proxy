import { mkdirSync } from "node:fs";
import type { Config } from "../models/config";

export function loadConfig(): Config {
	const hostname = process.env.LISTENER ?? "0.0.0.0";
	const port = Number(process.env.TIMEMACHINE_PORT) || 8765;
	const proxyBase = process.env.PROXY_BASE_URL ?? `http://${hostname}:${port}`;
	const proxyBaseHostname = new URL(proxyBase).hostname;

	return {
		port,
		hostname,
		defaultTime: process.env.ARCHIVE_TIME ?? "19980101000000",
		archivePrefix: process.env.URL_PREFIX ?? "https://web.archive.org/web",
		cacheDir: process.env.CACHE_DIR ?? "/app/cache",
		cacheEnabled: process.env.CACHE_ENABLED?.toLowerCase() !== "false",
		allowedOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:5173")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
		archiveRatePerSec: Number(process.env.ARCHIVE_RATE_PER_SEC) || 2,
		archiveBurst: Number(process.env.ARCHIVE_BURST) || 5,
		archiveMaxRetries: Number(process.env.ARCHIVE_MAX_RETRIES) || 3,
		archiveMaxConcurrent: Number(process.env.ARCHIVE_MAX_CONCURRENT) || 10,
		whitelistHosts: process.env.WHITELIST_HOSTS ?? "*",
		proxyPrefix: process.env.PROXY_PREFIX ?? "",
		proxyBase,
		proxyBaseHostname,
		cacheClearToken: process.env.CACHE_CLEAR_TOKEN ?? "",
		wsKeepaliveMs: Number(process.env.WS_KEEPALIVE_MS) || 30_000,
		redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
		bullmqPrefix: process.env.BULLMQ_PREFIX ?? "tm",
		domainCrawlEnabled: process.env.DOMAIN_CRAWL_ENABLED?.toLowerCase() !== "false",
		workerConcurrency: Number(process.env.WORKER_CONCURRENCY) || 2,
		workerRateLimitPerSec: Number(process.env.WORKER_RATE_LIMIT_PER_SEC) || 1,
		downloaderThreadsCount: Number(process.env.DOWNLOADER_THREADS_COUNT) || 3,
		crawlMaxCdxPages: Number(process.env.CRAWL_MAX_CDX_PAGES) || 50,
		outboundProxyUrl: process.env.OUTBOUND_PROXY_URL ?? "",
		outboundProxyUsername: process.env.OUTBOUND_PROXY_USERNAME ?? "",
		outboundProxyPassword: process.env.OUTBOUND_PROXY_PASSWORD ?? "",
	};
}

export function ensureCacheDir(cacheDir: string): void {
	mkdirSync(cacheDir, { recursive: true });
}
