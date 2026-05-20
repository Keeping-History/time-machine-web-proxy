import { promises as fs } from "node:fs";
import { type ConnectionOptions, type QueueEvents, Worker } from "bullmq";
import type pino from "pino";
import { WaybackMachineDownloader } from "wayback-machine-downloader";
import { dayWindow } from "../lib/archive-time";
import { normalizeBaseUrlInput } from "../lib/normalize-base-url";
import type { CacheService } from "../services/cache";
import { assertDomainCrawlJob, assertExactUrlJob, QUEUE_CRAWL, QUEUE_EXACT } from "./jobs";

// Wayback Availability API. Given a URL + target timestamp it returns the
// nearest real capture, e.g. {archived_snapshots:{closest:{timestamp:...}}}.
// Required because wayback-machine-downloader uses CDX `from`/`to` ranges,
// and second-precision `from=to=<time>` virtually never matches a capture.
const AVAILABILITY_URL = "https://archive.org/wayback/available";
// 30s rather than the undici default-ish 10s: production logs show sporadic
// connect timeouts to web.archive.org under that ceiling, and a precondition
// call timing out here would surface to the user as a 500 even though the
// downloader could likely have succeeded.
const AVAILABILITY_TIMEOUT_MS = 30_000;

interface AvailabilityResponse {
	readonly archived_snapshots?: {
		readonly closest?: {
			readonly timestamp?: string;
			readonly available?: boolean;
		};
	};
}

async function findNearestSnapshotTimestamp(url: string, time: string): Promise<string> {
	const u = `${AVAILABILITY_URL}?url=${encodeURIComponent(url)}&timestamp=${time}`;
	const r = await fetch(u, { signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS) });
	if (!r.ok) throw new Error(`Wayback availability ${r.status}`);
	const body = (await r.json()) as AvailabilityResponse;
	const closest = body.archived_snapshots?.closest;
	if (!closest?.available || !closest.timestamp) {
		throw new Error(`No archived snapshot for ${url} near ${time}`);
	}
	return closest.timestamp;
}

async function directoryHasFiles(dir: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
		return entries.some((e) => e.isFile());
	} catch {
		return false;
	}
}

export interface StartArchiveWorkersOpts {
	connection: ConnectionOptions;
	cache: Pick<CacheService, "cacheDirForJob">;
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
			const directory = cache.cacheDirForJob(time, base.bareHost);
			logger.info({ url, time, directory }, "[worker:exact] start");
			// Resolve the user's requested second to the nearest real capture.
			// Without this the downloader's CDX `from=to=<exact-second>` query
			// returns zero snapshots almost every time.
			const snapped = await findNearestSnapshotTimestamp(base.canonicalUrl, time);
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
			// The downloader returns successfully on zero-result CDX queries,
			// which would mark the BullMQ job `completed` with an empty cache
			// directory and surface as a misleading 502 at the API layer. Fail
			// the job explicitly so BullMQ retries (and the caller sees a real
			// error) when nothing was actually written.
			if (!(await directoryHasFiles(directory))) {
				throw new Error(`Downloader produced no files for ${url} @ ${time} (snapped ${snapped})`);
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
