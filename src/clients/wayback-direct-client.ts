import type pino from "pino";
import { TIMESTAMP_RE } from "../lib/archive-time";
import { describeFetchError } from "../lib/errors";
import { logger as defaultLogger } from "../lib/logger";
const RESOLVED_TIME_RE = /\/web\/(\d{14})id_\//;
const WAYBACK_BASE = "https://web.archive.org/web";

const DEFAULT_RATE_PER_SECOND = 20;
const DEFAULT_BURST = 30;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BREAKER_BASE_MS = 5_000;
const DEFAULT_BREAKER_MAX_MS = 600_000;

export type DirectFetchOutcome = "ok" | "not_found" | "fallback";

export interface ResolvedResult {
	outcome: DirectFetchOutcome;
	body?: Buffer;
	contentType?: string;
	reason?: string;
}

export interface RequestedResult extends ResolvedResult {
	resolvedTime?: string;
}

export interface WaybackDirectClientConfig {
	ratePerSecond?: number;
	burst?: number;
	timeoutMs?: number;
	/** Initial cooldown when ECONNREFUSED opens the breaker, ms. Default 5_000. */
	breakerBaseMs?: number;
	/** Maximum cooldown after repeated HALF_OPEN probe failures, ms. Default 600_000. */
	breakerMaxMs?: number;
	logger?: pino.Logger;
}

/**
 * Single-state circuit breaker shared across both fetch methods. Trips only
 * on ECONNREFUSED — other transport errors (timeouts, ENOTFOUND, etc.) and
 * HTTP error statuses do not affect breaker state. While OPEN, all calls
 * short-circuit without touching the network or token bucket.
 *
 * State machine:
 *   CLOSED → OPEN on ECONNREFUSED (cooldown = baseMs).
 *   OPEN → HALF_OPEN at cooldown expiry; exactly one caller becomes the
 *     probe, others get "half-open-busy" until the probe resolves.
 *   HALF_OPEN → CLOSED on probe success (any non-ECONNREFUSED outcome,
 *     including 5xx/timeout — the upstream answered, that's enough).
 *   HALF_OPEN → OPEN on probe ECONNREFUSED (cooldown doubles, capped at maxMs).
 */
type BreakerVerdict = "proceed" | "open" | "half-open-busy";

class CircuitBreaker {
	private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
	private openedAt = 0;
	private cooldownMs: number;
	private readonly baseMs: number;
	private readonly maxMs: number;

	constructor(baseMs: number, maxMs: number) {
		this.baseMs = baseMs;
		this.maxMs = maxMs;
		this.cooldownMs = baseMs;
	}

	tryAcquire(): BreakerVerdict {
		if (this.state === "CLOSED") return "proceed";
		if (this.state === "HALF_OPEN") return "half-open-busy";
		// OPEN — check whether the cooldown has expired.
		if (Date.now() >= this.openedAt + this.cooldownMs) {
			// Atomic in single-threaded JS: this caller becomes the probe.
			this.state = "HALF_OPEN";
			return "proceed";
		}
		return "open";
	}

	recordSuccess(): void {
		this.state = "CLOSED";
		this.openedAt = 0;
		this.cooldownMs = this.baseMs;
	}

	recordEconnRefused(): void {
		// From HALF_OPEN: the probe failed, double cooldown (capped).
		// From CLOSED: first failure, keep cooldown at baseMs.
		// From OPEN: tryAcquire short-circuits before any fetch, so we never
		// arrive here from OPEN. Defensive no-op if it ever happens.
		if (this.state === "HALF_OPEN") {
			this.cooldownMs = Math.min(this.maxMs, this.cooldownMs * 2);
		}
		this.state = "OPEN";
		this.openedAt = Date.now();
	}
}

function isEconnRefused(e: unknown): boolean {
	const cause = (e as { cause?: unknown })?.cause;
	if (cause && typeof cause === "object" && "code" in cause) {
		return (cause as { code: unknown }).code === "ECONNREFUSED";
	}
	if (e && typeof e === "object" && "code" in e) {
		return (e as { code: unknown }).code === "ECONNREFUSED";
	}
	return false;
}

/**
 * Simple token-bucket rate limiter.
 *
 * Tokens accumulate at `ratePerSecond` up to `burst`. Each call to `consume()`
 * deducts one token, returning a promise that resolves when a token is available.
 * Time is read via `Date.now()` so jest fake timers can control it in tests.
 */
class TokenBucket {
	private tokens: number;
	private lastRefillMs: number;
	private readonly ratePerMs: number;
	private readonly burst: number;

	constructor(ratePerSecond: number, burst: number) {
		this.ratePerMs = ratePerSecond / 1_000;
		this.burst = burst;
		this.tokens = burst;
		this.lastRefillMs = Date.now();
	}

	/** Returns the number of milliseconds to wait before a token is available. */
	private refill(): void {
		const now = Date.now();
		const elapsed = now - this.lastRefillMs;
		this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerMs);
		this.lastRefillMs = now;
	}

	/**
	 * Consumes one token. If no token is available, returns the number of ms
	 * to wait. If a token is available, returns 0 and decrements tokens.
	 */
	tryConsume(): number {
		this.refill();
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return 0;
		}
		// How long until we have 1 token at current fill rate?
		return (1 - this.tokens) / this.ratePerMs;
	}

	/**
	 * Waits until a token is available and consumes it. Uses real setTimeout
	 * so jest fake timers can be used in tests by calling jest.runAllTimers /
	 * jest.advanceTimersByTime.
	 */
	async consume(): Promise<void> {
		const waitMs = this.tryConsume();
		if (waitMs > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
			// After waiting, try again (tokens may have been consumed by other waiters)
			return this.consume();
		}
	}
}

/**
 * Direct Wayback Machine fetch client with two modes:
 *
 * - `fetchAtResolvedTime`: fetches `id_` URLs for an exact known timestamp.
 * - `fetchAtRequestedTime`: fetches `id_` URLs for a requested timestamp that
 *   may not have a capture; Wayback redirects to the nearest snapshot.
 *   Extracts resolvedTime from the final response URL.
 *
 * Both methods use `redirect: "follow"` and share a token bucket + circuit breaker.
 */
export class WaybackDirectClient {
	private readonly bucket: TokenBucket;
	private readonly timeoutMs: number;
	private readonly breaker: CircuitBreaker;
	private readonly log: pino.Logger;

	constructor(config: WaybackDirectClientConfig = {}) {
		this.bucket = new TokenBucket(
			config.ratePerSecond ?? DEFAULT_RATE_PER_SECOND,
			config.burst ?? DEFAULT_BURST,
		);
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.breaker = new CircuitBreaker(
			config.breakerBaseMs ?? DEFAULT_BREAKER_BASE_MS,
			config.breakerMaxMs ?? DEFAULT_BREAKER_MAX_MS,
		);
		this.log = config.logger ?? defaultLogger;
	}

	/** Waits for a rate-limit token to become available and consumes it. */
	private async awaitToken(url: string, ts: string): Promise<void> {
		const waitMs = this.bucket.tryConsume();
		if (waitMs > 0) {
			this.log.debug({ url, ts, waitMs }, "[direct] rate-limited");
			await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
			await this.bucket.consume();
		}
	}

	/**
	 * Fetches the Wayback snapshot at exactly the given timestamp using the
	 * `id_` modifier (raw content, no Wayback toolbar). Uses `redirect: "follow"`
	 * so Wayback redirects to the nearest capture are transparently followed.
	 *
	 * Returns:
	 *   - `ok` + body/contentType on 200
	 *   - `not_found` on 404
	 *   - `fallback` on 4xx/5xx, timeout, redirect-limit exceeded, or bad timestamp
	 */
	async fetchAtResolvedTime(url: string, ts: string): Promise<ResolvedResult> {
		if (!TIMESTAMP_RE.test(ts)) {
			return { outcome: "fallback", reason: "bad-timestamp" };
		}

		const verdict = this.breaker.tryAcquire();
		if (verdict === "open") return { outcome: "fallback", reason: "circuit-open" };
		if (verdict === "half-open-busy") {
			return { outcome: "fallback", reason: "circuit-half-open-busy" };
		}

		await this.awaitToken(url, ts);

		const archiveUrl = `${WAYBACK_BASE}/${ts}id_/${url}`;
		this.log.debug({ archiveUrl, ts }, "[direct] resolved-fetch");

		let res: Response;
		try {
			res = await globalThis.fetch(archiveUrl, {
				redirect: "follow",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (e) {
			// undici wraps the real failure in a generic `TypeError: fetch failed`
			// whose `.cause` is the actual SystemError (ENOTFOUND, ECONNRESET,
			// AbortError on timeout, "no healthy proxy" from the rotator, etc.).
			// Unwrap so the operator sees the actual cause, not the wrapper.
			if (isEconnRefused(e)) {
				this.breaker.recordEconnRefused();
				this.log.warn(
					{ archiveUrl },
					"[wayback-direct] ECONNREFUSED → opening circuit",
				);
			} else {
				this.breaker.recordSuccess();
			}
			const reason = describeFetchError(e);
			this.log.warn({ archiveUrl, reason }, "[wayback-direct] fetchAtResolvedTime fetch error");
			return { outcome: "fallback", reason };
		}
		this.breaker.recordSuccess();
		this.log.info({ archiveUrl, status: res.status }, "[wayback-direct] response");

		if (res.status === 404) {
			return { outcome: "not_found" };
		}

		if (res.status === 200) {
			const arrayBuffer = await res.arrayBuffer();
			return {
				outcome: "ok",
				body: Buffer.from(arrayBuffer),
				contentType: res.headers.get("content-type") ?? undefined,
			};
		}

		return { outcome: "fallback", reason: `http-${res.status}` };
	}

	/**
	 * Fetches the Wayback snapshot using the `id_` modifier for a requested
	 * timestamp that may not have a capture. Wayback redirects to the nearest
	 * snapshot; the resolved timestamp is extracted from the final response URL.
	 *
	 * Returns:
	 *   - `ok` + body/contentType/resolvedTime on 200
	 *   - `not_found` on 404
	 *   - `fallback` on other errors, timeout, or bad timestamp
	 */
	async fetchAtRequestedTime(url: string, ts: string): Promise<RequestedResult> {
		if (!TIMESTAMP_RE.test(ts)) {
			return { outcome: "fallback", reason: "bad-timestamp" };
		}

		const verdict = this.breaker.tryAcquire();
		if (verdict === "open") return { outcome: "fallback", reason: "circuit-open" };
		if (verdict === "half-open-busy") {
			return { outcome: "fallback", reason: "circuit-half-open-busy" };
		}

		await this.awaitToken(url, ts);

		const archiveUrl = `${WAYBACK_BASE}/${ts}id_/${url}`;
		this.log.debug({ archiveUrl, ts }, "[direct] requested-fetch");

		let res: Response;
		try {
			res = await globalThis.fetch(archiveUrl, {
				redirect: "follow",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (e) {
			// Same unwrap as fetchAtResolvedTime — see comment there for rationale.
			if (isEconnRefused(e)) {
				this.breaker.recordEconnRefused();
				this.log.warn(
					{ archiveUrl },
					"[wayback-direct] ECONNREFUSED → opening circuit",
				);
			} else {
				this.breaker.recordSuccess();
			}
			const reason = describeFetchError(e);
			this.log.warn({ archiveUrl, reason }, "[wayback-direct] fetchAtRequestedTime fetch error");
			return { outcome: "fallback", reason };
		}
		this.breaker.recordSuccess();
		this.log.info({ archiveUrl, status: res.status }, "[wayback-direct] response");

		if (res.status === 404) {
			return { outcome: "not_found" };
		}

		if (res.status === 200) {
			const resolvedTimeMatch = RESOLVED_TIME_RE.exec(res.url);
			const resolvedTime = resolvedTimeMatch?.[1];
			const arrayBuffer = await res.arrayBuffer();
			return {
				outcome: "ok",
				body: Buffer.from(arrayBuffer),
				contentType: res.headers.get("content-type") ?? undefined,
				resolvedTime,
			};
		}

		return { outcome: "fallback", reason: `http-${res.status}` };
	}
}
