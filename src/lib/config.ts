import { mkdirSync } from "node:fs";
import type { Config, OutboundProxyChooser } from "../models/config";

const parseSnapshotWindowDays = (csv: string): number[] => {
	const parts = csv.split(",").map((s) => s.trim());
	if (parts.length === 0 || parts.some((s) => s === "")) {
		throw new Error(`Invalid SNAPSHOT_WINDOW_DAYS: empty entry in "${csv}"`);
	}
	const parsed = parts.map((s) => Number.parseInt(s, 10));
	if (parsed.some((n) => !Number.isFinite(n) || n < 0)) {
		throw new Error(`Invalid SNAPSHOT_WINDOW_DAYS: "${csv}" — must be non-negative integers`);
	}
	return parsed;
};

function parseOutboundProxyUrls(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseOutboundProxyChooser(raw: string | undefined): OutboundProxyChooser {
	if (!raw) return "sequential";
	const lowered = raw.trim().toLowerCase();
	if (lowered === "sequential" || lowered === "random") return lowered;
	throw new Error(`OUTBOUND_PROXY_CHOOSER must be "sequential" or "random" (got "${raw}")`);
}

function parseOutboundProxyCooldownMs(raw: string | undefined): number {
	if (raw === undefined || raw === "") return 60_000;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`OUTBOUND_PROXY_COOLDOWN_SECONDS must be a non-negative number (got "${raw}")`);
	}
	return Math.floor(parsed * 1000);
}

export function loadConfig(): Config {
	const hostname = process.env.LISTENER ?? "0.0.0.0";
	const port = Number(process.env.TIMEMACHINE_PORT) || 8765;
	const proxyBase = process.env.PROXY_BASE_URL ?? `http://${hostname}:${port}`;
	const proxyBaseHostname = new URL(proxyBase).hostname;

	return {
		port,
		hostname,
		defaultTime: process.env.ARCHIVE_TIME ?? "19980101000000",
		cacheDir: process.env.CACHE_DIR ?? "/app/cache",
		cacheEnabled: process.env.CACHE_ENABLED?.toLowerCase() !== "false",
		allowedOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:5173")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
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
		outboundProxyUrls: parseOutboundProxyUrls(process.env.OUTBOUND_PROXY_URLS),
		outboundProxyChooser: parseOutboundProxyChooser(process.env.OUTBOUND_PROXY_CHOOSER),
		outboundProxyUsername: process.env.OUTBOUND_PROXY_USERNAME ?? "",
		outboundProxyPassword: process.env.OUTBOUND_PROXY_PASSWORD ?? "",
		outboundProxyCooldownMs: parseOutboundProxyCooldownMs(
			process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS,
		),
		snapshotWindowDays: parseSnapshotWindowDays(
			process.env.SNAPSHOT_WINDOW_DAYS ?? "30,365,3650,0",
		),
		allowLaterFallback: process.env.ALLOW_LATER_FALLBACK?.toLowerCase() === "true",
	};
}

export function ensureCacheDir(cacheDir: string): void {
	mkdirSync(cacheDir, { recursive: true });
}
