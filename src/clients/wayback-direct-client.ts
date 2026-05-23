import { logger as defaultLogger } from "../lib/logger";
import type pino from "pino";

const TIMESTAMP_RE = /^\d{14}$/;
const RESOLVED_TIME_RE = /\/web\/(\d{14})id_\//;
const WAYBACK_BASE = "https://web.archive.org/web";

const DEFAULT_RATE_PER_SECOND = 20;
const DEFAULT_BURST = 30;
const DEFAULT_TIMEOUT_MS = 10_000;

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
	logger?: pino.Logger;
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
 * - `fetchAtResolvedTime`: fetches `id_` URLs (no redirect follow). 3xx → fallback.
 * - `fetchAtRequestedTime`: fetches `im_` URLs (follow redirects), extracts
 *   resolvedTime from the final response URL.
 *
 * Both methods are rate-limited by a shared token bucket.
 */
export class WaybackDirectClient {
	private readonly bucket: TokenBucket;
	private readonly timeoutMs: number;
	private readonly log: pino.Logger;

	constructor(config: WaybackDirectClientConfig = {}) {
		this.bucket = new TokenBucket(
			config.ratePerSecond ?? DEFAULT_RATE_PER_SECOND,
			config.burst ?? DEFAULT_BURST,
		);
		this.timeoutMs =
			config.timeoutMs ??
			(process.env.DIRECT_FETCH_TIMEOUT_MS
				? Number(process.env.DIRECT_FETCH_TIMEOUT_MS)
				: DEFAULT_TIMEOUT_MS);
		this.log = config.logger ?? defaultLogger;
	}

	/**
	 * Fetches the Wayback snapshot at exactly the given timestamp using the
	 * `id_` modifier (raw content, no Wayback toolbar). Uses `redirect: 'manual'`
	 * so any 3xx is treated as a fallback rather than followed.
	 *
	 * Returns:
	 *   - `ok` + body/contentType on 200
	 *   - `not_found` on 404
	 *   - `fallback` on any 3xx, other 4xx, 5xx, timeout, or bad timestamp
	 */
	async fetchAtResolvedTime(url: string, ts: string): Promise<ResolvedResult> {
		if (!TIMESTAMP_RE.test(ts)) {
			return { outcome: "fallback", reason: "bad-timestamp" };
		}

		const waitMs = this.bucket.tryConsume();
		if (waitMs > 0) {
			this.log.debug({ url, ts, waitMs }, "[direct] rate-limited");
			await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
			await this.bucket.consume();
		}

		const archiveUrl = `${WAYBACK_BASE}/${ts}id_/${url}`;
		this.log.debug({ archiveUrl, ts }, "[direct] resolved-fetch");

		let res: Response;
		try {
			res = await globalThis.fetch(archiveUrl, {
				redirect: "manual",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			this.log.debug({ archiveUrl, reason }, "[wayback-direct] fetchAtResolvedTime fetch error");
			return { outcome: "fallback", reason };
		}

		if (res.status >= 300 && res.status < 400) {
			this.log.debug(
				{ archiveUrl, status: res.status },
				"[wayback-direct] fetchAtResolvedTime redirect → fallback",
			);
			return { outcome: "fallback", reason: `redirect-${res.status}` };
		}

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
	 * Fetches the Wayback snapshot using the `im_` modifier which follows
	 * redirects to the nearest available capture. Extracts the resolved
	 * timestamp from the final response URL.
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

		const waitMs = this.bucket.tryConsume();
		if (waitMs > 0) {
			this.log.debug({ url, ts, waitMs }, "[direct] rate-limited");
			await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
			await this.bucket.consume();
		}

		const archiveUrl = `${WAYBACK_BASE}/${ts}im_/${url}`;
		this.log.debug({ archiveUrl, ts }, "[direct] requested-fetch");

		let res: Response;
		try {
			res = await globalThis.fetch(archiveUrl, {
				redirect: "follow",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			this.log.debug({ archiveUrl, reason }, "[wayback-direct] fetchAtRequestedTime fetch error");
			return { outcome: "fallback", reason };
		}

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
