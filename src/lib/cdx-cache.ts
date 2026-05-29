import { createHash } from "node:crypto";
import type pino from "pino";

// Minimal Redis surface the helper uses — satisfied by real IORedis and by
// simple jest mocks in tests without importing the full ioredis type.
interface RedisCacheClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, expiryMode: "EX", time: number): Promise<unknown>;
}

const HISTORICAL_TTL_S = 7 * 24 * 60 * 60;
const OPEN_EDGE_TTL_S = 5 * 60;
const HISTORICAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const TIMESTAMP_RE = /^\d{14}$/;

const inflight = new Map<string, Promise<Response>>();

export interface CdxCacheDeps {
	redis: RedisCacheClient | null;
	logger: pino.Logger;
	enabled: boolean;
	bullmqPrefix: string;
	// Caller-supplied predicate: only HTTP 200 responses whose body passes this
	// are written to Redis. Guards against Wayback LB returning HTML error pages
	// with status 200 during incidents — without it those would be cached for
	// up to 7 days.
	validate: (body: string) => boolean;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export async function cachedCdxFetch(
	url: string,
	init: RequestInit,
	deps: CdxCacheDeps,
): Promise<Response> {
	const f = deps.fetchImpl ?? fetch;
	if (!deps.enabled || deps.redis === null) return f(url, init);

	const key = `${deps.bullmqPrefix}-cdx:${hashUrl(url)}`;

	const cached = await readCache(deps.redis, key, deps.logger);
	if (cached !== null) {
		deps.logger.debug({ key, bytes: cached.length }, "[cdx-cache] hit");
		return new Response(cached, { status: 200 });
	}

	const existing = inflight.get(key);
	if (existing) return existing.then((r) => r.clone());

	const p = (async () => {
		const res = await f(url, init);
		if (!res.ok) return res;
		const body = await res.text();
		if (!deps.validate(body)) {
			deps.logger.debug({ key, bytes: body.length }, "[cdx-cache] skip-write: validate failed");
			return new Response(body, { status: 200, headers: res.headers });
		}
		const ttl = computeTtlS(url, deps.now?.() ?? Date.now());
		writeCache(deps.redis!, key, body, ttl, deps.logger);
		return new Response(body, { status: 200, headers: res.headers });
	})();

	inflight.set(key, p);
	try {
		return await p;
	} finally {
		inflight.delete(key);
	}
}

function hashUrl(url: string): string {
	return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function computeTtlS(url: string, nowMs: number): number {
	const to = new URL(url).searchParams.get("to");
	if (!to || !TIMESTAMP_RE.test(to)) return OPEN_EDGE_TTL_S;
	const toMs = Date.UTC(
		+to.slice(0, 4),
		+to.slice(4, 6) - 1,
		+to.slice(6, 8),
		+to.slice(8, 10),
		+to.slice(10, 12),
		+to.slice(12, 14),
	);
	return toMs < nowMs - HISTORICAL_THRESHOLD_MS ? HISTORICAL_TTL_S : OPEN_EDGE_TTL_S;
}

async function readCache(
	redis: RedisCacheClient,
	key: string,
	logger: pino.Logger,
): Promise<string | null> {
	try {
		return await redis.get(key);
	} catch (e) {
		logger.warn({ key, err: errMsg(e) }, "[cdx-cache] redis GET failed");
		return null;
	}
}

function writeCache(
	redis: RedisCacheClient,
	key: string,
	body: string,
	ttlS: number,
	logger: pino.Logger,
): void {
	redis.set(key, body, "EX", ttlS).catch((e: unknown) =>
		logger.warn({ key, err: errMsg(e) }, "[cdx-cache] redis SET failed"),
	);
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
