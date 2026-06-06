import { mkdirSync } from "node:fs";
import { parseDomainRemap } from "./hostname-normalizer";
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

function parseBool(raw: string | undefined, envName: string, defaultValue: boolean): boolean {
	if (raw === undefined || raw === "") return defaultValue;
	const lower = raw.trim().toLowerCase();
	if (lower === "true") return true;
	if (lower === "false") return false;
	throw new Error(`${envName} must be "true" or "false" (got "${raw}")`);
}

function parseIntInRange(
	raw: string | undefined,
	envName: string,
	defaultValue: number,
	min: number,
	max: number,
): number {
	if (raw === undefined || raw === "") return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
		throw new Error(`${envName} must be an integer (got "${raw}")`);
	}
	if (parsed < min || parsed > max) {
		throw new Error(`${envName} must be between ${min} and ${max} (got ${parsed})`);
	}
	return parsed;
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
		// Direct/top-level URLs: strict at-or-before by default. The user typed
		// a time and expects the page state at that time — drifting forward to
		// a later capture changes what they're viewing. Opt in with
		// ALLOW_LATER_FALLBACK=true if a strict snapshot is unavailable too often.
		allowLaterFallback: process.env.ALLOW_LATER_FALLBACK?.toLowerCase() === "true",
		// Asset URLs (images, CSS, JS, fonts, media): bidirectional closest by
		// default. Sub-resources at the exact requested timestamp are rare;
		// without later-fallback the proxy 404s assets that exist a few hours
		// after the requested time. Opt out with ASSET_LATER_FALLBACK=false.
		assetLaterFallback: process.env.ASSET_LATER_FALLBACK?.toLowerCase() !== "false",

		// Direct-fetch kill switches and tuning knobs
		directFetchEnabled: parseBool(process.env.DIRECT_FETCH_ENABLED, "DIRECT_FETCH_ENABLED", true),
		directFetchMaxConcurrent: parseIntInRange(
			process.env.DIRECT_FETCH_MAX_CONCURRENT,
			"DIRECT_FETCH_MAX_CONCURRENT",
			10,
			1,
			50,
		),
		directFetchTimeoutMs: parseIntInRange(
			process.env.DIRECT_FETCH_TIMEOUT_MS,
			"DIRECT_FETCH_TIMEOUT_MS",
			30_000,
			1_000,
			60_000,
		),
		directFetchRatePerSec: parseIntInRange(
			process.env.DIRECT_FETCH_RATE_PER_SEC,
			"DIRECT_FETCH_RATE_PER_SEC",
			20,
			1,
			100,
		),
		directFetchBurst: parseIntInRange(
			process.env.DIRECT_FETCH_BURST,
			"DIRECT_FETCH_BURST",
			30,
			1,
			200,
		),
		directFetchPoolConnections: parseIntInRange(
			process.env.DIRECT_FETCH_POOL_CONNECTIONS,
			"DIRECT_FETCH_POOL_CONNECTIONS",
			5,
			1,
			50,
		),
		directFetchPoolKeepaliveMs: parseIntInRange(
			process.env.DIRECT_FETCH_POOL_KEEPALIVE_MS,
			"DIRECT_FETCH_POOL_KEEPALIVE_MS",
			30_000,
			1_000,
			300_000,
		),
		directFetchPoolMaxConcurrentStreams: parseIntInRange(
			process.env.DIRECT_FETCH_POOL_MAX_STREAMS,
			"DIRECT_FETCH_POOL_MAX_STREAMS",
			10,
			1,
			100,
		),
		directFetchHttp2Enabled: parseBool(
			process.env.DIRECT_FETCH_HTTP2_ENABLED,
			"DIRECT_FETCH_HTTP2_ENABLED",
			true,
		),
		directFetchBlockedBaseMs: parseIntInRange(
			process.env.DIRECT_FETCH_BLOCKED_BASE_MS,
			"DIRECT_FETCH_BLOCKED_BASE_MS",
			5_000,
			1_000,
			300_000,
		),
		directFetchBlockedMaxMs: parseIntInRange(
			process.env.DIRECT_FETCH_BLOCKED_MAX_MS,
			"DIRECT_FETCH_BLOCKED_MAX_MS",
			600_000,
			1_000,
			3_600_000,
		),

		// Prewarm knobs
		prewarmEnabled: parseBool(process.env.PREWARM_ENABLED, "PREWARM_ENABLED", true),
		prewarmMaxAssetsPerPage: parseIntInRange(
			process.env.PREWARM_MAX_ASSETS_PER_PAGE,
			"PREWARM_MAX_ASSETS_PER_PAGE",
			100,
			0,
			500,
		),

		// CDX response cache
		cdxCacheEnabled: parseBool(process.env.CDX_CACHE_ENABLED, "CDX_CACHE_ENABLED", true),

		// Sentinel TTL
		notFoundTtlDays: parseIntInRange(
			process.env.NOT_FOUND_TTL_DAYS,
			"NOT_FOUND_TTL_DAYS",
			30,
			1,
			3650,
		),

		// URL rewriter — omit timestamp segment from rewritten links
		lockTime: parseBool(process.env.LOCK_TIME, "LOCK_TIME", false),

		// Hostname normalizer
		domainRemap: parseDomainRemap(process.env.DOMAIN_REMAP),
	};
}

export function ensureCacheDir(cacheDir: string): void {
	mkdirSync(cacheDir, { recursive: true });
}

/** Singleton parsed config. Evaluated once at module load; safe to import
 * anywhere except test files that need to override env vars (call loadConfig()
 * directly in those). */
export const config: ReturnType<typeof loadConfig> = loadConfig();
