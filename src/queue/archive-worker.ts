import { type ConnectionOptions, type Job, type QueueEvents, Worker } from "bullmq";
import type pino from "pino";
import type { RequestedResult, ResolvedResult } from "../clients/wayback-direct-client";
import { dayWindow } from "../lib/archive-time";
import type { JobProgress, JobProgressQueue, JobProgressStage } from "../models/job-progress";
import type { CacheService } from "../services/cache";
import { assertDomainCrawlJob, assertExactUrlJob, QUEUE_CRAWL, QUEUE_EXACT } from "./jobs";

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
// Matches AVAILABILITY_TIMEOUT_MS / CDX_TIMEOUT_MS elsewhere — Wayback CDX
// is often slow but not deeply unreachable, so giving each enumeration call
// 30s avoids spurious TimeoutError on the first attempt.
const CDX_ENUM_TIMEOUT_MS = 30_000;

/**
 * Minimal structural shape of the direct-fetch client the workers need. Kept
 * local to avoid an import cycle with `lib/dependencies.ts`, which is the
 * module that constructs the real `DedupingDirectClient` and passes it in.
 *
 * `fetchAtRequestedTime` drives the exact worker: Wayback's `im_` endpoint
 * resolves the nearest snapshot server-side and redirects to it, sidestepping
 * the CDX endpoint entirely. `fetchAtResolvedTime` is still used by the crawl
 * worker, which already knows the exact timestamp from its CDX enumeration.
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
	/** Fetch implementation used to enumerate crawl URLs from CDX. Production
	 *  passes the cached CDX fetch so repeated host crawls share Redis cache
	 *  entries with snapshot-resolver and the size preflight. */
	cdxFetch: typeof fetch;
	logger: pino.Logger;
	bullmqPrefix: string;
	workerConcurrency: number;
	workerRateLimitPerSec: number;
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

interface CdxRow {
	original: string;
	timestamp: string;
}

/**
 * Enumerate URLs captured for `host` within `[from, to]` via CDX. Returns one
 * row per unique URL (collapsed by `urlkey`) restricted to status 200. Throws
 * on transport/parse failure so BullMQ retries the crawl.
 */
async function enumerateHostUrls(
	host: string,
	from: string,
	to: string,
	cdxFetch: typeof fetch,
	logger: pino.Logger,
): Promise<CdxRow[]> {
	const params = new URLSearchParams();
	params.set("url", `${host}/*`);
	params.set("from", from);
	params.set("to", to);
	params.set("output", "json");
	params.set("fl", "original,timestamp");
	params.set("filter", "statuscode:200");
	params.set("collapse", "urlkey");
	const url = `${CDX_ENDPOINT}?${params.toString()}`;
	const res = await cdxFetch(url, { signal: AbortSignal.timeout(CDX_ENUM_TIMEOUT_MS) });
	if (!res.ok) {
		throw new Error(`CDX enumeration ${res.status} for ${host}`);
	}
	const text = await res.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`CDX enumeration returned non-JSON for ${host}: ${text.slice(0, 80)}…`);
	}
	if (!Array.isArray(json) || json.length === 0) return [];
	// First row is the field-name header (["original", "timestamp"]); drop it
	// so the caller only sees data rows.
	const rows =
		Array.isArray(json[0]) && (json[0] as unknown[])[0] === "original" ? json.slice(1) : json;
	const out: CdxRow[] = [];
	for (const row of rows) {
		if (!Array.isArray(row) || row.length < 2) continue;
		const [original, timestamp] = row;
		if (typeof original !== "string" || typeof timestamp !== "string") continue;
		if (!/^\d{14}$/.test(timestamp)) continue;
		try {
			// CDX sometimes returns `originals` whose hostname is a subdomain or
			// uppercase variant of the requested host; restrict to exact-match
			// so the cache layout (keyed by URL.hostname) stays consistent.
			const u = new URL(original);
			if (u.hostname.toLowerCase() !== host.toLowerCase()) continue;
		} catch {
			continue;
		}
		out.push({ original, timestamp });
	}
	logger.debug({ host, from, to, count: out.length }, "[worker:crawl] CDX enumeration complete");
	return out;
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
		cdxFetch,
		logger,
		bullmqPrefix,
		workerConcurrency,
		workerRateLimitPerSec,
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
				// Skip CDX entirely. Wayback's `im_` endpoint redirects to the
				// nearest available capture, so a single round-trip handles both
				// snapshot resolution and download in one go. CDX is a separate
				// Wayback service that throttles independently — relying on it
				// here produced "all CDX queries failed" job failures even when
				// the `im_` path was healthy.
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

	let crawl!: Worker;
	crawl = new Worker(
		QUEUE_CRAWL,
		async (job) => {
			try {
				assertDomainCrawlJob(job.data);
				const { host, time } = job.data;
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

				try {
					const rows = await enumerateHostUrls(host, from, to, cdxFetch, logger);
					await emitProgress(job, QUEUE_CRAWL, "download_start", logger, {
						host,
						time,
						filesSeen: 0,
					});

					let filesSeen = 0;
					await applyRateLimit(crawl, async () => {
						let rateLimited = false;
						for (const row of rows) {
							let result: ResolvedResult;
							try {
								result = await directClient.fetchAtResolvedTime(row.original, row.timestamp);
							} catch (err) {
								logger.debug(
									{
										host,
										url: row.original,
										err: err instanceof Error ? err.message : String(err),
									},
									"[worker:crawl] direct fetch error",
								);
								continue;
							}
							if (
								result.outcome === "fallback" &&
								result.reason &&
								RATE_LIMIT_RE.test(result.reason)
							) {
								// Stop hammering Wayback further within this job — remaining
								// rows would just compound the rate-limit violation.
								rateLimited = true;
								break;
							}
							if (result.outcome !== "ok" || !result.body) continue;
							try {
								await cache.writeFile(row.original, time, result.body);
								if (result.contentType) {
									await cache.writeContentTypeSidecar(row.original, time, result.contentType);
								}
								filesSeen += 1;
								await emitProgress(job, QUEUE_CRAWL, "download_file", logger, {
									host,
									time,
									file: new URL(row.original).pathname,
									filesSeen,
								});
							} catch (err) {
								logger.warn(
									{
										host,
										url: row.original,
										err: err instanceof Error ? err.message : String(err),
									},
									"[worker:crawl] cache write failed",
								);
							}
						}
						if (rateLimited) {
							throw new Error("direct fetch returned 429 during crawl");
						}
					});

					await emitProgress(job, QUEUE_CRAWL, "download_done", logger, {
						host,
						time,
						filesSeen,
					});
				} finally {
					clearInterval(extender);
				}
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
