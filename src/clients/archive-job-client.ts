import { createHash } from "node:crypto";
import type { Queue, QueueEvents } from "bullmq";
import type pino from "pino";
import { isJobProgress, type JobProgress } from "../models/job-progress";
import type { DomainCrawlJob, ExactUrlJob } from "../queue/jobs";

/**
 * Deterministic job IDs for in-flight dedup. Two concurrent foreground
 * requests for the same (url, time) share one BullMQ job; the second
 * caller's `waitUntilFinished` subscribes to the same execution.
 *
 * Custom jobIds must NOT be purely numeric (BullMQ throws
 * "Custom Id cannot be integers"), so the "e-" / "c-" prefix is load-bearing.
 */
const exactJobId = (url: string, time: string): string =>
	`e-${createHash("sha256").update(`${url}|${time}`).digest("hex").slice(0, 16)}`;

const crawlJobId = (host: string, time: string): string =>
	`c-${createHash("sha256").update(`${host}|${time}`).digest("hex").slice(0, 16)}`;

/**
 * Foreground job options.
 *
 * - `attempts: 3` + exponential backoff (delay 2000) → between-attempt waits
 *   of 0+2+4 = 6s; with each Wayback attempt capped at ~60s, worst-case
 *   wall-clock = 3*60 + 6 = 186s, leaving 14s slack under WAIT_TIMEOUT_MS.
 * - `removeOnComplete: { count: 100, age: 3600 }` uses AGE-based retention
 *   alongside count to prevent the `waitUntilFinished` hang race: with
 *   count-only retention, a successful job purged from the ring buffer
 *   before the second caller subscribes leaves `waitUntilFinished` hanging
 *   until timeout. The 1h floor ensures recent completions are kept.
 *   Source: BullMQ issue #85.
 */
const EXACT_JOB_OPTS = {
	attempts: 3,
	backoff: { type: "exponential" as const, delay: 2000 },
	removeOnComplete: { count: 100, age: 3600 },
	removeOnFail: 1000,
} as const;

const CRAWL_JOB_OPTS = {
	attempts: 3,
	backoff: { type: "exponential" as const, delay: 2000 },
	removeOnComplete: { count: 100, age: 3600 },
	removeOnFail: 1000,
} as const;

/**
 * Wall-clock timeout for `waitUntilFinished`. Covers the worst-case retry
 * chain (see EXACT_JOB_OPTS) with a 14s margin.
 */
const WAIT_TIMEOUT_MS = 200_000;

export type JobProgressListener = (progress: JobProgress) => void;

/**
 * Narrow port that ProxyService depends on. The concrete BullMQ-backed
 * implementation below satisfies this shape, and Dependencies (TASK-010)
 * can swap in a real or stub instance without breaking ProxyService.
 */
export interface ArchiveJobClientPort {
	enqueueExactAndWait(url: string, time: string, onProgress?: JobProgressListener): Promise<void>;
	enqueueExact(url: string, time: string): Promise<void>;
	enqueueDomainCrawl(host: string, time: string): Promise<void>;
}

/**
 * BullMQ producer for archive jobs.
 *
 * - `enqueueExactAndWait` is BLOCKING — caller awaits the foreground
 *   download via `QueueEvents.waitUntilFinished`. An optional `onProgress`
 *   callback receives JobProgress payloads as the worker advances through
 *   stages (picked_up → availability_start → resolved → download_start →
 *   download_file* → download_done).
 * - `enqueueDomainCrawl` is FIRE-AND-FORGET — caller does not await
 *   completion; suppressed entirely when `domainCrawlEnabled` is false.
 *   Crawl progress is still emitted by the worker (visible in Bull Board /
 *   server logs) but no per-call callback is exposed because there's no
 *   foreground waiter to forward to.
 *
 * SSRF policy: this is the transport/producer layer. It does NOT enforce
 * URL policy. The caller (TimeMachineService.validateTargetUrl) is
 * responsible for rejecting private/internal hosts and disallowed
 * protocols BEFORE the URL ever reaches this client.
 */
export class ArchiveJobClient implements ArchiveJobClientPort {
	constructor(
		private readonly exactQueue: Queue<ExactUrlJob>,
		private readonly crawlQueue: Queue<DomainCrawlJob>,
		private readonly exactEvents: QueueEvents,
		private readonly logger: pino.Logger,
		private readonly domainCrawlEnabled: boolean,
	) {}

	async enqueueExactAndWait(
		url: string,
		time: string,
		onProgress?: JobProgressListener,
	): Promise<void> {
		const jobId = exactJobId(url, time);
		const job = await this.exactQueue.add("exact", { url, time }, { ...EXACT_JOB_OPTS, jobId });
		this.logger.debug(
			{ jobId: job.id, url, time },
			"[archive-job-client] enqueued exact, awaiting",
		);

		// Subscribe to QueueEvents 'progress' filtered by our jobId. BullMQ emits
		// `{ jobId, data }` where data is the JobProgress we passed to
		// updateProgress in the worker. Unsubscribe in finally so a hung
		// callback can't leak listeners across calls.
		const progressHandler = ({ jobId: evJobId, data }: { jobId: string; data: unknown }): void => {
			if (evJobId !== job.id) return;
			if (!onProgress) return;
			if (!isJobProgress(data)) return;
			try {
				onProgress(data);
			} catch (e) {
				this.logger.warn(
					{ jobId: evJobId, err: e instanceof Error ? e.message : String(e) },
					"[archive-job-client] onProgress callback threw",
				);
			}
		};
		if (onProgress) this.exactEvents.on("progress", progressHandler);
		try {
			await job.waitUntilFinished(this.exactEvents, WAIT_TIMEOUT_MS);
		} finally {
			if (onProgress) this.exactEvents.off("progress", progressHandler);
		}
	}

	async enqueueExact(url: string, time: string): Promise<void> {
		const jobId = exactJobId(url, time);
		await this.exactQueue.add("exact", { url, time }, { ...EXACT_JOB_OPTS, jobId });
		this.logger.debug({ jobId, url, time }, "[archive-job-client] enqueued exact (crawl fan-out)");
	}

	async enqueueDomainCrawl(host: string, time: string): Promise<void> {
		if (!this.domainCrawlEnabled) return;
		const jobId = crawlJobId(host, time);
		await this.crawlQueue.add("crawl", { host, time }, { ...CRAWL_JOB_OPTS, jobId });
		this.logger.debug({ jobId, host, time }, "[archive-job-client] enqueued crawl");
	}
}
