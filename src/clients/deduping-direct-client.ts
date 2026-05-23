import type { ResolvedResult, RequestedResult, WaybackDirectClient } from "./wayback-direct-client";

export interface DedupingDirectClientOptions {
	maxConcurrency?: number;
}

/**
 * Wraps a WaybackDirectClient with two guarantees:
 *
 * 1. **In-flight dedup**: concurrent calls with identical (method, url, ts)
 *    share one upstream request. Both callers receive the same resolved value.
 *    On rejection the inflight entry is cleared so the next caller retries.
 *
 * 2. **Concurrency cap**: at most `maxConcurrency` upstream requests run
 *    simultaneously. Additional requests are queued FIFO and dispatched as
 *    slots free up.
 *
 * `fetchAtResolvedTime` and `fetchAtRequestedTime` are deduplicated in
 * separate namespaces so a resolved-ts call never satisfies a requested-ts
 * call for the same (url, ts).
 */
export class DedupingDirectClient {
	private readonly inner: WaybackDirectClient;
	private readonly maxConcurrency: number;

	/** Active in-flight promises, keyed by "<namespace>:<url>:<ts>". */
	private readonly inflight = new Map<string, Promise<ResolvedResult | RequestedResult>>();

	/** Number of requests currently executing (past the semaphore gate). */
	private running = 0;

	/**
	 * FIFO queue of thunks to start when a slot frees. Each thunk calls fn()
	 * synchronously and resolves/rejects the outer promise wrapper stored in
	 * `inflight`. Storing thunks (not just resolve callbacks) lets `release()`
	 * start the next upstream call synchronously — no extra microtask hop.
	 */
	private readonly waiters: Array<() => void> = [];

	constructor(inner: WaybackDirectClient, opts: DedupingDirectClientOptions = {}) {
		this.inner = inner;
		this.maxConcurrency = opts.maxConcurrency ?? 10;
	}

	// ---------------------------------------------------------------------------
	// Semaphore helpers
	// ---------------------------------------------------------------------------

	/** Release one semaphore slot, dispatching the next waiter synchronously if any. */
	private release(): void {
		if (this.waiters.length > 0) {
			// Transfer the slot directly to the next waiter — slot count stays
			// the same (one finishes, one starts).
			const next = this.waiters.shift()!;
			next();
		} else {
			this.running--;
		}
	}

	// ---------------------------------------------------------------------------
	// Dedup + semaphore wrapper
	// ---------------------------------------------------------------------------

	private dedupedFetch<T extends ResolvedResult>(
		key: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const existing = this.inflight.get(key);
		if (existing) {
			return existing as Promise<T>;
		}

		let promise: Promise<T>;

		if (this.running < this.maxConcurrency) {
			// Slot available — start fn() synchronously so the inner call is
			// observable immediately (no extra microtask hop before invocation).
			this.running++;
			promise = fn().then(
				(v) => { this.release(); this.inflight.delete(key); return v; },
				(e) => { this.release(); this.inflight.delete(key); return Promise.reject(e); },
			);
		} else {
			// All slots busy — build the outer promise now and queue a thunk
			// that will call fn() synchronously when a slot frees in release().
			let outerResolve!: (v: T | PromiseLike<T>) => void;
			let outerReject!: (e: unknown) => void;
			promise = new Promise<T>((res, rej) => {
				outerResolve = res;
				outerReject = rej;
			});

			this.waiters.push(() => {
				// Called synchronously by release() — fn() runs immediately here.
				fn().then(
					(v) => { this.release(); this.inflight.delete(key); outerResolve(v); },
					(e) => { this.release(); this.inflight.delete(key); outerReject(e); },
				);
			});
		}

		this.inflight.set(key, promise);
		return promise;
	}

	// ---------------------------------------------------------------------------
	// Public API — mirrors WaybackDirectClient
	// ---------------------------------------------------------------------------

	fetchAtResolvedTime(url: string, ts: string): Promise<ResolvedResult> {
		const key = `resolved:${url}:${ts}`;
		return this.dedupedFetch(key, () => this.inner.fetchAtResolvedTime(url, ts));
	}

	fetchAtRequestedTime(url: string, ts: string): Promise<RequestedResult> {
		const key = `requested:${url}:${ts}`;
		return this.dedupedFetch(key, () => this.inner.fetchAtRequestedTime(url, ts));
	}
}
