import { promises as fs } from "node:fs";
import { type ConnectionOptions, type Job, type QueueEvents, Worker } from "bullmq";
import type IORedis from "ioredis";
import type pino from "pino";
import type { RequestedResult, ResolvedResult } from "../clients/wayback-direct-client";
import { cachedCdxFetch } from "../lib/cdx-cache";
import { windowAround } from "../lib/archive-time";
import type { JobProgress, JobProgressQueue, JobProgressStage } from "../models/job-progress";
import type { CacheService } from "../services/cache";
import { rewriteHtmlUrls, stripWaybackToolbar } from "../lib/url-rewriter";
import {
	assertDomainCrawlChunkJob,
	assertDomainCrawlJob,
	assertExactUrlJob,
	QUEUE_CRAWL,
	QUEUE_CRAWL_CHUNK,
	QUEUE_EXACT,
} from "./jobs";
import { parseCdxPage, pickClosestPerUrl } from "./cdx-page";

/**
 * Minimal structural shape of the direct-fetch client the workers need. Kept
 * local to avoid an import cycle with `lib/dependencies.ts`, which is the
 * module that constructs the real `DedupingDirectClient` and passes it in.
 *
 * `fetchAtRequestedTime` drives the exact worker: Wayback's `id_` endpoint
 * resolves the nearest snapshot server-side and redirects to it, sidestepping
 * the CDX endpoint entirely.
 */
export interface ArchiveDirectClient {
	fetchAtRequestedTime(url: string, ts: string): Promise<RequestedResult>;
	fetchAtResolvedTime(url: string, ts: string): Promise<ResolvedResult>;
}

export interface StartArchiveWorkersOpts {
	connection: ConnectionOptions;
	cache: Pick<
		CacheService,
		| "cacheDirForJob"
		| "writeFile"
		| "writeContentTypeSidecar"
		| "writeNotFoundSentinel"
		| "writeResolvedTimeSidecar"
		| "lookup"
	>;
	directClient: ArchiveDirectClient;
	/** Fire-and-forget callback to enqueue an archive-exact job for a discovered
	 *  link. Keeps the crawl worker decoupled from BullMQ internals. */
	enqueueExactJob: (url: string, time: string) => Promise<void>;
	logger: pino.Logger;
	bullmqPrefix: string;
	workerConcurrency: number;
	workerRateLimitPerSec: number;
	redis: IORedis | null;
	cdxCacheEnabled: boolean;
	crawlWindowDays: number;
}

export interface ArchiveWorkers {
	exact: Worker;
	crawl: Worker;
	chunk: Worker;
}

const CRAWL_LOCK_DURATION_MS = 120_000;
// On a 429 from the direct fetch path we throttle the worker for one minute
// before requeuing. Matches the Wayback cooldown documented in the original
// downloader plan.
const RATE_LIMIT_PAUSE_MS = 60_000;
const RATE_LIMIT_RE = /429|rate.?limit/i;
const CDX_TIMEOUT_MS = 30_000;

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

const TIMESTAMP_RE = /^\d{14}$/;

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
		cdxCacheEnabled,
		crawlWindowDays,
	} = opts;

	const limiter = { max: workerRateLimitPerSec, duration: 1000 };

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
				const { hostname } = new URL(url);
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
						await cache.writeFile(url, time, result.body);
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
							file: new URL(url).pathname,
							filesSeen: 1,
						});
						return;
					}
					if (result.outcome === "not_found") {
						await cache.writeNotFoundSentinel(time, url);
						notFound = true;
						return;
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

	const crawl = new Worker(
		QUEUE_CRAWL,
		async (job) => {
			try {
				assertDomainCrawlJob(job.data);
				const { host, time } = job.data;
				await emitProgress(job, QUEUE_CRAWL, "picked_up", logger, { host, time });

				// Root may be http or https depending on when Wayback crawled it.
				const rootCandidates = [`http://${host}/`, `https://${host}/`];
				let rootHit: Awaited<ReturnType<typeof opts.cache.lookup>> = null;
				let rootUrl = rootCandidates[0];
				for (const candidate of rootCandidates) {
					rootHit = await opts.cache.lookup(candidate, time);
					if (rootHit) {
						rootUrl = candidate;
						break;
					}
				}

				if (!rootHit) {
					// Root not cached yet — enqueue it and exit. The next crawl trigger
					// after the root is served will find it cached and extract links.
					logger.info({ host, time }, "[worker:crawl] root not cached — enqueuing exact job for root");
					await enqueueExactJob(rootUrl, time);
					await emitProgress(job, QUEUE_CRAWL, "download_done", logger, { host, time, filesSeen: 0 });
					return;
				}

				await emitProgress(job, QUEUE_CRAWL, "download_start", logger, { host, time, filesSeen: 0 });

				const raw = await fs.readFile(rootHit.absPath);
				const { discoveredAssets } = rewriteHtmlUrls(
					stripWaybackToolbar(raw.toString("utf-8")),
					rootUrl,
					time,
					false,
				);

				const sameHostLinks = discoveredAssets.filter((a) => {
					try {
						return new URL(a.url).hostname === host;
					} catch {
						return false;
					}
				});

				let filesSeen = 0;
				for (const link of sameHostLinks) {
					await enqueueExactJob(link.url, link.embeddedTs);
					filesSeen += 1;
					await emitProgress(job, QUEUE_CRAWL, "download_file", logger, {
						host,
						time,
						file: new URL(link.url).pathname,
						filesSeen,
					});
				}

				await emitProgress(job, QUEUE_CRAWL, "download_done", logger, { host, time, filesSeen });
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

	// Trust boundary: whitelist check is done at the producer (ProxyService.maybeEnqueueDomainCrawl).
	// The chunk worker does NOT re-check — jobs in this queue are pre-approved.
	let chunk!: Worker;
	chunk = new Worker(
		QUEUE_CRAWL_CHUNK,
		async (job) => {
			try {
				assertDomainCrawlChunkJob(job.data);
				const { host, time, page } = job.data;
				await emitProgress(job, QUEUE_CRAWL_CHUNK, "picked_up", logger, { host, time, page });

				const { from, to } = windowAround(time, crawlWindowDays);
				const cdxUrl =
					`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(`${host}/*`)}` +
					`&from=${from}&to=${to}&output=json&page=${page}`;

				const rows = await applyRateLimit(chunk, async () => {
					const r = await cachedCdxFetch(
						cdxUrl,
						{ signal: AbortSignal.timeout(CDX_TIMEOUT_MS) },
						{ redis, logger, enabled: cdxCacheEnabled, bullmqPrefix, validate: () => true },
					);
					if (!r.ok) throw new Error(`CDX fetch ${r.status}`);
					return parseCdxPage(await r.json());
				});

				const captures = pickClosestPerUrl(rows, time);
				for (const { url, timestamp } of captures) {
					await enqueueExactJob(url, timestamp);
				}
				await emitProgress(job, QUEUE_CRAWL_CHUNK, "download_done", logger, {
					host,
					time,
					page,
					filesSeen: captures.length,
				});
			} catch (e) {
				await emitProgress(job, QUEUE_CRAWL_CHUNK, "error", logger, {
					error: e instanceof Error ? e.message : String(e),
				});
				throw e;
			}
		},
		{
			connection,
			concurrency: workerConcurrency,
			limiter,
			prefix: bullmqPrefix,
			lockDuration: CRAWL_LOCK_DURATION_MS,
			stalledInterval: 30_000,
			maxStalledCount: 2,
		},
	);

	const attachFailedLogger = (w: Worker, name: "exact" | "crawl" | "chunk"): void => {
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
	attachFailedLogger(chunk, "chunk");

	return { exact, crawl, chunk };
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
