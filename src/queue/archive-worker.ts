import { type ConnectionOptions, type QueueEvents, Worker } from "bullmq";
import type pino from "pino";
import { WaybackMachineDownloader } from "wayback-machine-downloader";
import { dayWindow } from "../lib/archive-time";
import { normalizeBaseUrlInput } from "../lib/normalize-base-url";
import type { CacheService } from "../services/cache";
import { assertDomainCrawlJob, assertExactUrlJob, QUEUE_CRAWL, QUEUE_EXACT } from "./jobs";

// Wayback CDX search API. We use this (not the Availability API) to find
// the latest capture AT OR BEFORE the requested time. Why CDX:
//   - Availability's `closest=before` is unreliable: it can return future
//     captures (observed: target 20010917, returned 20020803).
//   - In strict-match mode Availability won't bridge http/https for sites
//     whose early captures are http-only (e.g. apple.com pre-2000 returns
//     empty when queried as https://).
//   - CDX uses SURT canonicalization, which is the same form the downloader
//     queries internally — so the snap timestamp is guaranteed to correspond
//     to a capture the downloader can find.
const CDX_URL = "https://web.archive.org/cdx/search/cdx";
// 30s rather than the undici default-ish 10s: production logs show sporadic
// connect timeouts to web.archive.org under that ceiling, and a precondition
// call timing out here would surface to the user as a 500 even though the
// downloader could likely have succeeded.
const CDX_TIMEOUT_MS = 30_000;

async function findLatestSnapshotAtOrBefore(url: string, time: string): Promise<string> {
	// Strip the scheme so Wayback's URL canonicalizer handles http/https
	// archive variants uniformly. CDX uses SURT (scheme-agnostic) keys, but
	// some Wayback paths still treat scheme-included URLs literally.
	const schemeless = url.replace(/^https?:\/\//i, "");
	// `to=<time>` upper-bounds the search at the requested timestamp.
	// `limit=-1` returns just the LAST matching row, which is the most
	// recent capture in the window — exactly what "at or before" means.
	const u =
		`${CDX_URL}?url=${encodeURIComponent(schemeless)}` +
		`&to=${time}&limit=-1&output=json`;
	const r = await fetch(u, { signal: AbortSignal.timeout(CDX_TIMEOUT_MS) });
	if (!r.ok) throw new Error(`Wayback CDX ${r.status}`);
	const body = (await r.json()) as unknown;
	// CDX returns [[headers], [row1], …]. Empty result is just [[headers]]
	// or `[]`. The capture timestamp lives at column index 1.
	if (!Array.isArray(body) || body.length < 2) {
		throw new Error(`No archived snapshot for ${url} at or before ${time}`);
	}
	const row = body[1];
	if (!Array.isArray(row) || typeof row[1] !== "string") {
		throw new Error(`No archived snapshot for ${url} at or before ${time}`);
	}
	return row[1];
}

export interface StartArchiveWorkersOpts {
	connection: ConnectionOptions;
	cache: Pick<CacheService, "cacheDirForJob" | "lookup">;
	logger: pino.Logger;
	bullmqPrefix: string;
	workerConcurrency: number;
	workerRateLimitPerSec: number;
	downloaderThreadsCount: number;
}

export interface ArchiveWorkers {
	exact: Worker;
	crawl: Worker;
}

// Lock-extender cadence for the crawl worker. The Worker holds the job lock
// for `lockDuration` (120s); BullMQ re-queues stalled jobs after that. We
// extend the lock every 110s so a multi-minute crawl never appears stalled.
const CRAWL_LOCK_DURATION_MS = 120_000;
const CRAWL_LOCK_EXTEND_INTERVAL_MS = CRAWL_LOCK_DURATION_MS - 10_000;
// On a downloader-surfaced 429 we throttle the worker for one minute before
// requeuing. Matches the Wayback 2026 cooldown documented in the plan.
const RATE_LIMIT_PAUSE_MS = 60_000;
const RATE_LIMIT_RE = /429|rate.?limit/i;

export function startArchiveWorkers(opts: StartArchiveWorkersOpts): ArchiveWorkers {
	const {
		connection,
		cache,
		logger,
		bullmqPrefix,
		workerConcurrency,
		workerRateLimitPerSec,
		downloaderThreadsCount,
	} = opts;

	const limiter = { max: workerRateLimitPerSec, duration: 1000 };

	const runWithRateLimitGuard = async <T>(worker: Worker, fn: () => Promise<T>): Promise<T> => {
		try {
			return await fn();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (RATE_LIMIT_RE.test(msg)) {
				await worker.rateLimit(RATE_LIMIT_PAUSE_MS);
				throw Worker.RateLimitError();
			}
			throw err;
		}
	};

	// `let exact!: Worker` lets the processor closure reference the worker
	// itself for `worker.rateLimit(...)`. Same pattern for crawl below.
	let exact!: Worker;
	exact = new Worker(
		QUEUE_EXACT,
		async (job) => {
			assertExactUrlJob(job.data);
			const { url, time } = job.data;
			const base = normalizeBaseUrlInput(url);
			// Cache directory keys on the URL's hostname verbatim — www.example.com
			// and example.com are stored as separate entries because they can
			// legitimately serve different content. `base.canonicalUrl` is still
			// used as the Wayback API key (Wayback collapses www/apex for its own
			// indexing), but that's a Wayback-side concern, not a cache-key one.
			const { hostname } = new URL(url);
			const directory = cache.cacheDirForJob(time, hostname);
			logger.info({ url, time, directory }, "[worker:exact] start");
			// Resolve the user's requested second to the latest real capture
			// AT OR BEFORE that time via CDX (see findLatestSnapshotAtOrBefore
			// for why CDX, not the Availability API).
			const snapped = await findLatestSnapshotAtOrBefore(base.canonicalUrl, time);
			if (snapped !== time) {
				logger.info(
					{ url, requestedTime: time, snapped },
					"[worker:exact] snapped to nearest capture",
				);
			}
			await runWithRateLimitGuard(exact, () =>
				new WaybackMachineDownloader({
					base_url: base.canonicalUrl,
					normalized_base: base,
					from_timestamp: snapped,
					to_timestamp: snapped,
					threads_count: downloaderThreadsCount,
					rewrite_mode: "as-is",
					canonical_action: "keep",
					exact_url: true,
					download_external_assets: false,
					directory,
				}).download_files(),
			);
			// Success criterion must match what the proxy reader requires for
			// THIS specific (url, time) — a host-level "directory has any file"
			// check used to mask zero-result CDX runs whenever sibling URLs at
			// the same host had been downloaded previously, marking the job
			// `completed` while the proxy then 502'd on the re-lookup.
			const hit = await cache.lookup(url, time);
			if (!hit) {
				throw new Error(
					`Downloader produced no usable file for ${url} @ ${time} (snapped ${snapped})`,
				);
			}
		},
		{
			connection,
			concurrency: workerConcurrency,
			limiter,
			prefix: bullmqPrefix,
		},
	);

	let crawl!: Worker;
	crawl = new Worker(
		QUEUE_CRAWL,
		async (job) => {
			assertDomainCrawlJob(job.data);
			const { host, time } = job.data;
			const base = normalizeBaseUrlInput(`https://${host}`);
			const directory = cache.cacheDirForJob(time, host);
			logger.info({ host, time, directory }, "[worker:crawl] start");

			const extender = setInterval(() => {
				// BullMQ guarantees `job.token` is defined inside an active processor;
				// the type is `string | undefined` because the same Job class is used
				// for jobs fetched outside the worker context.
				// biome-ignore lint/style/noNonNullAssertion: token is guaranteed inside processor
				const token = job.token!;
				job.extendLock(token, CRAWL_LOCK_DURATION_MS).catch((e: unknown) =>
					logger.warn(
						{
							jobId: job.id,
							err: e instanceof Error ? e.message : String(e),
						},
						"[worker:crawl] extendLock failed",
					),
				);
			}, CRAWL_LOCK_EXTEND_INTERVAL_MS);

			const { from, to } = dayWindow(time);
			try {
				await runWithRateLimitGuard(crawl, () =>
					new WaybackMachineDownloader({
						base_url: base.canonicalUrl,
						normalized_base: base,
						from_timestamp: from,
						to_timestamp: to,
						threads_count: downloaderThreadsCount,
						rewrite_mode: "as-is",
						canonical_action: "keep",
						exact_url: false,
						download_external_assets: false,
						directory,
					}).download_files(),
				);
			} finally {
				clearInterval(extender);
			}
		},
		{
			connection,
			concurrency: 1,
			limiter,
			prefix: bullmqPrefix,
			lockDuration: CRAWL_LOCK_DURATION_MS,
			stalledInterval: 30_000,
			maxStalledCount: 2,
		},
	);

	const attachFailedLogger = (w: Worker, name: "exact" | "crawl"): void => {
		w.on("failed", (job, err) => {
			logger.error(
				{
					jobId: job?.id,
					attemptsMade: job?.attemptsMade,
					data: job?.data,
					err: err.message,
				},
				`[worker:${name}] failed`,
			);
		});
	};
	attachFailedLogger(exact, "exact");
	attachFailedLogger(crawl, "crawl");

	return { exact, crawl };
}

/**
 * Attach a structured logger to a BullMQ QueueEvents stream. Emits one log
 * line per active|completed|failed|stalled transition. `durationMs` is
 * computed from a per-jobId start-time Map so completed/failed events report
 * end-to-end execution time.
 *
 * Intended to be wired by the dependencies layer (TASK-010) once per queue.
 */
export function attachQueueLogger(name: string, events: QueueEvents, logger: pino.Logger): void {
	const startTimes = new Map<string, number>();

	events.on("active", ({ jobId }) => {
		startTimes.set(jobId, Date.now());
		logger.debug({ queue: name, jobId, event: "active" }, `[queue:${name}] active`);
	});

	events.on("completed", ({ jobId }) => {
		const startedAt = startTimes.get(jobId);
		const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
		startTimes.delete(jobId);
		logger.info(
			{ queue: name, jobId, durationMs, event: "completed" },
			`[queue:${name}] completed`,
		);
	});

	events.on("failed", ({ jobId, failedReason }) => {
		const startedAt = startTimes.get(jobId);
		const durationMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
		startTimes.delete(jobId);
		logger.warn(
			{ queue: name, jobId, durationMs, failedReason, event: "failed" },
			`[queue:${name}] failed`,
		);
	});

	events.on("stalled", ({ jobId }) => {
		logger.warn({ queue: name, jobId, event: "stalled" }, `[queue:${name}] stalled`);
	});
}
