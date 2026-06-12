import { promises as fs } from "node:fs";
import { type ConnectionOptions, type Job, type QueueEvents, Worker } from "bullmq";
import type IORedis from "ioredis";
import type pino from "pino";
import type { ResolvedResult } from "../clients/wayback-direct-client";
import { TIMESTAMP_RE } from "../lib/archive-time";
import type { JobProgress, JobProgressQueue, JobProgressStage } from "../models/job-progress";
import type { CachePort } from "../models/cache-port";
import type { DirectClientPort } from "../models/direct-client";

/** @deprecated Use DirectClientPort from models/direct-client instead. */
export type ArchiveDirectClient = DirectClientPort;
import { discoverNavLinks, stripWaybackToolbar } from "../lib/url-rewriter";
import { assertDomainCrawlJob, assertExactUrlJob, type CrawlMeta, QUEUE_CRAWL, QUEUE_EXACT } from "./jobs";

export interface StartArchiveWorkersOpts {
	connection: ConnectionOptions;
	cache: CachePort;
	directClient: DirectClientPort;
	/** Fire-and-forget callback to enqueue an archive-exact job for a discovered
	 *  link, optionally carrying crawl provenance so the exact worker recurses
	 *  into same-host links. Keeps the crawl worker decoupled from BullMQ. */
	enqueueExactJob: (url: string, time: string, crawl?: CrawlMeta) => Promise<void>;
	logger: pino.Logger;
	bullmqPrefix: string;
	workerConcurrency: number;
	workerRateLimitPerSec: number;
	redis: IORedis | null;
	/** Recursive-crawl link depth (seed homepage is depth 0). */
	crawlMaxDepth: number;
	/** Max HTML pages to recurse into per crawl run (caps archive.org load). */
	crawlMaxPages: number;
}

export interface ArchiveWorkers {
	exact: Worker;
	crawl: Worker;
}

const CRAWL_LOCK_DURATION_MS = 120_000;
// A crawl run's Redis seen-set / page-budget keys expire after this long so a
// later re-crawl of the same (host, time) starts fresh.
const CRAWL_RUN_TTL_S = 6 * 60 * 60;
// On a 429 from the direct fetch path we throttle the worker for one minute
// before requeuing. Matches the Wayback cooldown documented in the original
// downloader plan.
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
 * Convert a direct-fetch failure outcome into a thrown error. Callers wrap
 * this in `applyRateLimit` so the BullMQ rate-limiter triggers on 429 paths.
 */
function failOnFallback(result: ResolvedResult, url: string, ts: string): never {
	const reason = result.reason ?? "unknown";
	throw new Error(`direct fetch fallback for ${url} @ ${ts}: ${reason}`);
}

/**
 * Inspect a thrown error and, if its message contains a 429/rate-limit
 * signal, drive the BullMQ rate-limit + re-queue dance. Other errors are
 * re-thrown unchanged so BullMQ's retry policy handles them.
 */
async function applyRateLimit<T>(worker: Worker, fn: () => Promise<T>): Promise<T> {
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
}

export function startArchiveWorkers(opts: StartArchiveWorkersOpts): ArchiveWorkers {
	const {
		connection,
		cache,
		directClient,
		enqueueExactJob,
		logger,
		bullmqPrefix,
		workerConcurrency,
		workerRateLimitPerSec,
		redis,
		crawlMaxDepth,
		crawlMaxPages,
	} = opts;

	const limiter = { max: workerRateLimitPerSec, duration: 1000 };

	// Recursive-crawl step: a same-host HTML page has been fetched and cached.
	// Discover its same-host navigation links and enqueue each unseen one as a
	// crawl-flagged exact job at depth+1. Bounded by a per-run page budget so a
	// large domain can't run away. Requires Redis for the seen-set + counter; a
	// no-op without it (recursion simply stops, one level deep).
	const recurseCrawl = async (
		meta: CrawlMeta,
		absPath: string,
		pageUrl: string,
		pageTime: string,
	): Promise<void> => {
		if (!redis) return;
		const countKey = `${bullmqPrefix}-crawl:count:${meta.rootHost}:${meta.rootTime}`;
		const pageCount = await redis.incr(countKey);
		if (pageCount === 1) await redis.expire(countKey, CRAWL_RUN_TTL_S);
		if (pageCount > crawlMaxPages) {
			if (pageCount === crawlMaxPages + 1)
				logger.info(
					{ host: meta.rootHost, time: meta.rootTime, budget: crawlMaxPages },
					"[worker:crawl] page budget reached — halting discovery",
				);
			return;
		}
		const html = (await fs.readFile(absPath)).toString("utf-8");
		const links = discoverNavLinks(stripWaybackToolbar(html), pageUrl, meta.rootHost);
		const seenKey = `${bullmqPrefix}-crawl:seen:${meta.rootHost}:${meta.rootTime}`;
		let enqueued = 0;
		for (const link of links) {
			// SADD returns 1 only for a URL not seen this run — the BFS dedup.
			if ((await redis.sadd(seenKey, link)) === 1) {
				await enqueueExactJob(link, pageTime, {
					rootHost: meta.rootHost,
					rootTime: meta.rootTime,
					depth: meta.depth + 1,
				});
				enqueued += 1;
			}
		}
		if (enqueued > 0) await redis.expire(seenKey, CRAWL_RUN_TTL_S);
		logger.info(
			{ pageUrl, depth: meta.depth, found: links.length, enqueued, pageCount },
			"[worker:crawl] recursed",
		);
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
				// Cache directory keys on the URL's hostname verbatim — www.example.com
				// and example.com are stored as separate entries because they can
				// legitimately serve different content. Must match CacheService.lookup,
				// which also keys on u.hostname (not base.bareHost).
				const { hostname, pathname } = new URL(url);
				const directory = cache.cacheDirForJob(time, hostname);

				await emitProgress(job, QUEUE_EXACT, "picked_up", logger, { url, time });
				logger.info({ url, time, directory }, "[worker:exact] start");

				await emitProgress(job, QUEUE_EXACT, "download_start", logger, { url, time });
				// Skip CDX entirely. Wayback's `id_` endpoint redirects to the
				// nearest available capture, so a single round-trip handles both
				// snapshot resolution and download in one go. CDX is a separate
				// Wayback service that throttles independently — relying on it
				// here produced "all CDX queries failed" job failures even when
				// the `id_` path was healthy.
				let resolvedTime: string | undefined;
				let notFound = false;
				await applyRateLimit(exact, async () => {
					const result = await directClient.fetchAtRequestedTime(url, time);
					if (result.outcome === "ok") {
						if (!result.body) {
							throw new Error(`direct fetch returned ok with no body for ${url} @ ${time}`);
						}
						await cache.writeStream(url, time, result.body);
						if (result.contentType) {
							await cache.writeContentTypeSidecar(url, time, result.contentType);
						}
						if (result.resolvedTime && TIMESTAMP_RE.test(result.resolvedTime)) {
							resolvedTime = result.resolvedTime;
						}
						await emitProgress(job, QUEUE_EXACT, "download_file", logger, {
							url,
							time,
							resolved: resolvedTime,
							file: pathname,
							filesSeen: 1,
						});
						return;
					}
					if (result.outcome === "not_found") {
						await cache.writeNotFoundSentinel(time, url);
						notFound = true;
						return;
					}
					// On the last attempt, write a tentative sentinel so the next
					// request fast-fails via cache.lookup instead of re-queuing the
					// full BullMQ retry chain while CDX is down.
					if (job.attemptsMade >= (job.opts?.attempts ?? 3) - 1) {
						await cache.writeTentativeNotFoundSentinel(time, url);
					}
					failOnFallback(result, url, time);
				});

				if (notFound) {
					logger.warn({ url, time }, "[worker:exact] no snapshot — wrote not-found sentinel");
					return;
				}

				await emitProgress(job, QUEUE_EXACT, "download_done", logger, {
					url,
					time,
					resolved: resolvedTime,
				});
				if (resolvedTime) {
					await cache.writeResolvedTimeSidecar(time, url, resolvedTime);
				}
				// Sanity check that the file the proxy reader will look for
				// actually landed where we expect.
				const hit = await cache.lookup(url, time);
				if (!hit) {
					throw new Error(`Direct fetch produced no usable file for ${url} @ ${time}`);
				}
				// Recursive crawl: only HTML pages that are part of a crawl recurse.
				// Assets (non-HTML) carry no crawl recursion, so the BFS terminates.
				const crawlMeta = job.data.crawl;
				if (
					crawlMeta &&
					crawlMeta.depth < crawlMaxDepth &&
					hit.contentType.startsWith("text/html")
				) {
					await recurseCrawl(crawlMeta, hit.absPath, url, time);
				}
			} catch (e) {
				const errMsg = e instanceof Error ? e.message : String(e);
				await emitProgress(job, QUEUE_EXACT, "error", logger, { error: errMsg });
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

	// Seeds the recursive (BFS) crawl. The actual page-graph walk happens in the
	// exact worker (recurseCrawl), which fetches each page then enqueues its
	// same-host links at depth+1. This job just kicks it off at the homepage.
	const crawl = new Worker(
		QUEUE_CRAWL,
		async (job) => {
			try {
				assertDomainCrawlJob(job.data);
				const { host, time } = job.data;
				await emitProgress(job, QUEUE_CRAWL, "picked_up", logger, { host, time });

				// Seed depth 0 with the homepage as a crawl-flagged exact job.
				// Wayback's id_ endpoint resolves http vs https for us, so seed http.
				const rootUrl = `http://${host}/`;
				if (redis) {
					const seenKey = `${bullmqPrefix}-crawl:seen:${host}:${time}`;
					await redis.sadd(seenKey, rootUrl);
					await redis.expire(seenKey, CRAWL_RUN_TTL_S);
				}
				await enqueueExactJob(rootUrl, time, { rootHost: host, rootTime: time, depth: 0 });
				await emitProgress(job, QUEUE_CRAWL, "download_done", logger, { host, time, filesSeen: 1 });
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
					err: err,
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
		startTimes.delete(jobId);
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
