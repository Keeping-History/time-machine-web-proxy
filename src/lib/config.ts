import { mkdirSync } from "node:fs";
import { parseDomainRemap } from "./hostname-normalizer";
import type { Config, OutboundProxyChooser } from "../models/config";

function parseWhitelist(raw: string): string[] {
	if (raw.trim() === "*") return ["*"];
	return raw
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean);
}

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
	const port = parseIntInRange(process.env.TIMEMACHINE_PORT, "TIMEMACHINE_PORT", 8765, 1, 65535);
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
		whitelistHosts: parseWhitelist(process.env.WHITELIST_HOSTS ?? ""),
		proxyBase,
		proxyBaseHostname,
		cacheClearToken: process.env.CACHE_CLEAR_TOKEN ?? "",
		wsKeepaliveMs: parseIntInRange(process.env.WS_KEEPALIVE_MS, "WS_KEEPALIVE_MS", 30_000, 1_000, 300_000),
		redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
		bullmqPrefix: process.env.BULLMQ_PREFIX ?? "tm",
		domainCrawlEnabled: process.env.DOMAIN_CRAWL_ENABLED?.toLowerCase() !== "false",
		workerConcurrency: parseIntInRange(process.env.WORKER_CONCURRENCY, "WORKER_CONCURRENCY", 2, 1, 50),
		workerRateLimitPerSec: parseIntInRange(process.env.WORKER_RATE_LIMIT_PER_SEC, "WORKER_RATE_LIMIT_PER_SEC", 1, 1, 100),
		crawlMaxDepth: parseIntInRange(process.env.CRAWL_MAX_DEPTH, "CRAWL_MAX_DEPTH", 3, 1, 20),
		crawlMaxPages: parseIntInRange(
			process.env.CRAWL_MAX_PAGES,
			"CRAWL_MAX_PAGES",
			1000,
			1,
			1_000_000,
		),
		outboundProxyUrls: parseOutboundProxyUrls(process.env.OUTBOUND_PROXY_URLS),
		outboundProxyChooser: parseOutboundProxyChooser(process.env.OUTBOUND_PROXY_CHOOSER),
		outboundProxyUsername: process.env.OUTBOUND_PROXY_USERNAME ?? "",
		outboundProxyPassword: process.env.OUTBOUND_PROXY_PASSWORD ?? "",
		outboundProxyCooldownMs: parseOutboundProxyCooldownMs(
			process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS,
		),
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

		// URL rewriter — hide the date from navigation links only (assets keep
		// their timestamp). See Config.lockTime for the full contract.
		lockTime: parseBool(process.env.LOCK_TIME, "LOCK_TIME", false),

		// Hostname normalizer
		domainRemap: parseDomainRemap(process.env.DOMAIN_REMAP),
	};
}

export function ensureCacheDir(cacheDir: string): void {
	mkdirSync(cacheDir, { recursive: true });
}

const CACHE_CLEAR_TOKEN_MIN_LENGTH = 16;

/**
 * Logs warnings about unsafe configuration values. Call this after the logger
 * is available (i.e. after loadConfig and createLogger in index.ts). Does NOT
 * throw — operators may have valid reasons for short-lived or constrained tokens.
 */
export function validateConfig(
	config: Config,
	logger: { warn: (msg: string) => void },
): void {
	if (
		config.cacheClearToken.length > 0 &&
		config.cacheClearToken.length < CACHE_CLEAR_TOKEN_MIN_LENGTH
	) {
		logger.warn(
			`[config] CACHE_CLEAR_TOKEN is set but shorter than ${CACHE_CLEAR_TOKEN_MIN_LENGTH} characters — consider using a longer token for adequate entropy`,
		);
	}
}
