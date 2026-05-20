import { type ConnectionOptions, type QueueEvents, Worker } from "bullmq";
import type pino from "pino";
import { WaybackMachineDownloader } from "wayback-machine-downloader";
import { normalizeBaseUrlInput } from "../lib/normalize-base-url";
import type { CacheService } from "../services/cache";
import { assertDomainCrawlJob, assertExactUrlJob, QUEUE_CRAWL, QUEUE_EXACT } from "./jobs";

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
			await runWithRateLimitGuard(exact, () =>
				new WaybackMachineDownloader({
					base_url: base.canonicalUrl,
					normalized_base: base,
					from_timestamp: time,
					to_timestamp: time,
					threads_count: downloaderThreadsCount,
					rewrite_mode: "as-is",
					canonical_action: "keep",
					exact_url: true,
					download_external_assets: false,
					directory,
				}).download_files(),
			);
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

			try {
				await runWithRateLimitGuard(crawl, () =>
					new WaybackMachineDownloader({
						base_url: base.canonicalUrl,
						normalized_base: base,
						from_timestamp: time,
						to_timestamp: time,
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
