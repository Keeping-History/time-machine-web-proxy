import { type FSWatcher, promises as fsp, watch as fsWatch } from "node:fs";
import {
	type ConnectionOptions,
	type Job,
	type QueueEvents,
	UnrecoverableError,
	Worker,
} from "bullmq";
import type pino from "pino";
import { WaybackMachineDownloader } from "wayback-machine-downloader";
import { dayWindow } from "../lib/archive-time";
import { installDownloaderLogging, runWithDownloaderLogging } from "../lib/downloader-logger";
import { normalizeBaseUrlInput } from "../lib/normalize-base-url";
import { isAssetUrl } from "../lib/url-rewriter";
import type { JobProgress, JobProgressQueue, JobProgressStage } from "../models/job-progress";
import type { CacheService } from "../services/cache";
import { assertDomainCrawlJob, assertExactUrlJob, QUEUE_CRAWL, QUEUE_EXACT } from "./jobs";

export type SnapshotResolverFn = (
	variants: string[],
	requestedTime: string,
	allowLaterFallback: boolean,
) => Promise<string | null>;

export interface StartArchiveWorkersOpts {
	connection: ConnectionOptions;
	cache: Pick<
		CacheService,
		| "cacheDirForJob"
		| "writeNotFoundSentinel"
		| "writeTentativeNotFoundSentinel"
		| "writeResolvedTimeSidecar"
		| "lookup"
	>;
	resolver: SnapshotResolverFn;
	logger: pino.Logger;
	bullmqPrefix: string;
	workerConcurrency: number;
	workerRateLimitPerSec: number;
	downloaderThreadsCount: number;
	/** Bidirectional resolution flag for DIRECT/top-level URLs. */
	allowLaterFallbackDirect: boolean;
	/** Bidirectional resolution flag for ASSET URLs (images, CSS, JS, fonts, media). */
	allowLaterFallbackAsset: boolean;
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

async function emitProgress(
	job: Job,
	queue: JobProgressQueue,
	stage: JobProgressStage,
	logger: pino.Logger,
	extras: Partial<JobProgress> = {},
): Promise<void> {
	const payload: JobProgress = {
		stage,
		jobId: job.id ?? "unknown",
		queue,
		ts: Date.now(),
		...extras,
	};
	// updateProgress writes to Redis + fires QueueEvents 'progress'. Awaited so
	// downstream subscribers see events in order.
	try {
		await job.updateProgress(payload);
	} catch (e) {
		// Never let a progress write fail the job — it's observability, not
		// correctness. Log and continue.
		logger.warn(
			{ jobId: payload.jobId, stage, err: e instanceof Error ? e.message : String(e) },
			`[worker:${queue}] updateProgress failed`,
		);
	}
	logger.info(payload, `[worker:${queue}] ${stage}`);
}

/**
 * Start `fs.watch` on `directory` (recursive) and invoke `onFile` once per
 * unique filename observed. Returns an async closer.
 *
 * `wayback-machine-downloader@0.5.0` exposes no progress hooks, so this is
 * the only way to surface per-file progress without monkey-patching stdout.
 * Events are de-duplicated by filename so transient `change` events after the
 * initial `rename` don't fire twice. Directory paths slip through occasionally
 * (Linux inotify can't reliably classify), which is acceptable — count is
 * approximate by design.
 */
export function startDownloadWatcher(
	directory: string,
	onFile: (relPath: string, count: number) => void,
	logger: pino.Logger,
	watchFn: typeof fsWatch = fsWatch,
): () => void {
	let watcher: FSWatcher | null = null;
	let closed = false;
	const seen = new Set<string>();
	// Fire-and-forget mkdir + watch setup. The processor MUST NOT block on
	// observability — if the downloader finishes before the watcher is up we
	// miss per-file events but the job still succeeds. Awaiting mkdir here
	// also breaks tests that use fake timers, because libuv's mkdir completion
	// callback is scheduled on the (mocked) event loop.
	fsp
		.mkdir(directory, { recursive: true })
		.then(() => {
			if (closed) return;
			watcher = watchFn(directory, { recursive: true }, (eventType, filename) => {
				if (!filename) return;
				const key = filename.toString();
				if (seen.has(key)) return;
				// 'rename' fires on creation/deletion; 'change' fires on writes to an
				// existing inode. New downloads always show up as 'rename' first.
				if (eventType !== "rename") return;
				// Concurrent workers writing sentinels into the same host dir would
				// otherwise surface here as "downloaded files" for this job.
				if (key.startsWith(".notfound/") || key.startsWith(".notfound-tentative/")) {
					return;
				}
				seen.add(key);
				onFile(key, seen.size);
			});
		})
		.catch((e: unknown) => {
			logger.warn(
				{ directory, err: e instanceof Error ? e.message : String(e) },
				"[worker] fs.watch setup failed — per-file progress disabled for this job",
			);
		});
	return () => {
		closed = true;
		try {
			watcher?.close();
		} catch {
			/* watcher already closed */
		}
	};
}

export function startArchiveWorkers(opts: StartArchiveWorkersOpts): ArchiveWorkers {
	const {
		connection,
		cache,
		resolver,
		logger,
		bullmqPrefix,
		workerConcurrency,
		workerRateLimitPerSec,
		downloaderThreadsCount,
		allowLaterFallbackDirect,
		allowLaterFallbackAsset,
	} = opts;

	const limiter = { max: workerRateLimitPerSec, duration: 1000 };

	// Flip the downloader into debug mode and route its console.log output
	// through pino (+ per-job BullMQ logs visible in bull-board). Idempotent —
	// safe to call across repeated startArchiveWorkers invocations.
	installDownloaderLogging();

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
			try {
				assertExactUrlJob(job.data);
				const { url, time } = job.data;
				const base = normalizeBaseUrlInput(url);
				// Cache directory keys on the URL's hostname verbatim — www.example.com
				// and example.com are stored as separate entries because they can
				// legitimately serve different content. Must match CacheService.lookup,
				// which also keys on u.hostname (not base.bareHost).
				const { hostname } = new URL(url);
				const directory = cache.cacheDirForJob(time, hostname);

				await emitProgress(job, QUEUE_EXACT, "picked_up", logger, { url, time });

				// Asset sub-resources (images, CSS, JS, fonts, media) opt into the
				// bidirectional resolver: an asset capture rarely aligns with the
				// requested page-level timestamp, and strict at-or-before would
				// 404 assets that exist a few hours/days later. Direct/top-level
				// URLs stay on the configured (default strict) policy so the user
				// sees the page state at the time they asked for.
				const isAsset = isAssetUrl(url);
				const allowLaterFallback = isAsset ? allowLaterFallbackAsset : allowLaterFallbackDirect;
				logger.info({ url, time, directory, isAsset, allowLaterFallback }, "[worker:exact] start");
				await emitProgress(job, QUEUE_EXACT, "availability_start", logger, { url, time });
				const resolved = await resolver(base.variants, time, allowLaterFallback);
				if (resolved === null) {
					await emitProgress(job, QUEUE_EXACT, "no_snapshot", logger, { url, time });
					logger.warn({ url, time }, "[worker:exact] no snapshot at-or-before requested time");
					await cache.writeNotFoundSentinel(time, url);
					return;
				}
				await emitProgress(job, QUEUE_EXACT, "resolved", logger, { url, time, resolved });
				logger.info({ url, time, resolved }, "[worker:exact] resolved snapshot");

				await emitProgress(job, QUEUE_EXACT, "download_start", logger, {
					url,
					time,
					resolved,
				});
				const stopWatch = startDownloadWatcher(
					directory,
					(file, filesSeen) => {
						void emitProgress(job, QUEUE_EXACT, "download_file", logger, {
							url,
							time,
							resolved,
							file,
							filesSeen,
						});
					},
					logger,
				);
				const downloaderLogger = logger.child({
					component: "wbm-downloader",
					queue: QUEUE_EXACT,
					jobId: job.id,
					url,
					time,
					resolved,
				});
				try {
					await runWithDownloaderLogging({ logger: downloaderLogger, job }, () =>
						runWithRateLimitGuard(exact, () =>
							new WaybackMachineDownloader({
								base_url: base.canonicalUrl,
								normalized_base: base,
								from_timestamp: resolved,
								to_timestamp: resolved,
								threads_count: downloaderThreadsCount,
								rewrite_mode: "as-is",
								canonical_action: "keep",
								exact_url: true,
								download_external_assets: true,
								directory,
							}).download_files(),
						),
					);
				} finally {
					stopWatch();
				}
				await emitProgress(job, QUEUE_EXACT, "download_done", logger, { url, time, resolved });
				await cache.writeResolvedTimeSidecar(time, url, resolved);
				// Success criterion must match what the proxy reader requires for
				// THIS specific (url, time) — a host-level "directory has any file"
				// check used to mask zero-result CDX runs whenever sibling URLs at
				// the same host had been downloaded previously, marking the job
				// `completed` while the proxy then 502'd on the re-lookup.
				const hit = await cache.lookup(url, time);
				if (!hit) {
					throw new Error(
						`Downloader produced no usable file for ${url} @ ${time} (resolved ${resolved})`,
					);
				}
			} catch (e) {
				const errMsg = e instanceof Error ? e.message : String(e);
				await emitProgress(job, QUEUE_EXACT, "error", logger, { error: errMsg });
				// snapshot-resolver throws this specific message when CDX is
				// transport-unreachable for every variant × retry. Retrying the
				// job 2 more times burns ~45s before BullMQ gives up and only
				// helps if CDX recovers in that window. Write a 1-hour tentative
				// sentinel so the next request fails fast, then surface the job
				// as failed via UnrecoverableError — BullMQ marks it failed
				// without retrying, so it appears in the Error column instead of
				// being silently completed with stage="error".
				if (errMsg.startsWith("[snapshot-resolver] all CDX queries failed")) {
					assertExactUrlJob(job.data);
					const { url, time } = job.data;
					await cache.writeTentativeNotFoundSentinel(time, url);
					logger.warn(
						{ url, time },
						"[worker:exact] indeterminate CDX state — wrote tentative sentinel, failing job without retry",
					);
					throw new UnrecoverableError(errMsg);
				}
				throw e;
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
			try {
				assertDomainCrawlJob(job.data);
				const { host, time } = job.data;
				const base = normalizeBaseUrlInput(`https://${host}`);
				const directory = cache.cacheDirForJob(time, host);

				await emitProgress(job, QUEUE_CRAWL, "picked_up", logger, { host, time });

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

				// Crawl downloads everything in a day-wide window rather than a single
				// resolved timestamp: a domain crawl is expected to span many distinct
				// captures across siblings, not lock to one snapshot.
				const { from, to } = dayWindow(time);

				await emitProgress(job, QUEUE_CRAWL, "download_start", logger, { host, time });
				const stopWatch = startDownloadWatcher(
					directory,
					(file, filesSeen) => {
						void emitProgress(job, QUEUE_CRAWL, "download_file", logger, {
							host,
							time,
							file,
							filesSeen,
						});
					},
					logger,
				);
				const downloaderLogger = logger.child({
					component: "wbm-downloader",
					queue: QUEUE_CRAWL,
					jobId: job.id,
					host,
					time,
				});
				try {
					await runWithDownloaderLogging({ logger: downloaderLogger, job }, () =>
						runWithRateLimitGuard(crawl, () =>
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
						),
					);
				} finally {
					stopWatch();
					clearInterval(extender);
				}
				await emitProgress(job, QUEUE_CRAWL, "download_done", logger, { host, time });
			} catch (e) {
				await emitProgress(job, QUEUE_CRAWL, "error", logger, {
					error: e instanceof Error ? e.message : String(e),
				});
				throw e;
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
 * line per active|completed|failed|stalled|progress transition. `durationMs`
 * is computed from a per-jobId start-time Map so completed/failed events
 * report end-to-end execution time.
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

	events.on("progress", ({ jobId, data }) => {
		// `data` is the JobProgress payload we passed to job.updateProgress.
		// Logged at debug so per-file events don't flood production logs.
		logger.debug(
			{ queue: name, jobId, event: "progress", progress: data },
			`[queue:${name}] progress`,
		);
	});
}
