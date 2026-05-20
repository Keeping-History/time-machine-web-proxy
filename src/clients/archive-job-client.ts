import { createHash } from "node:crypto";
import type { Queue, QueueEvents } from "bullmq";
import type pino from "pino";
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

/**
 * SSRF guard prefix. enqueueExactAndWait refuses URLs not starting with
 * this prefix.
 *
 * TODO(TASK-009): The plan's narrative says workers construct the Wayback
 * URL internally from the original target host, and the worker
 * (TASK-007) actually feeds the original URL through
 * `normalizeBaseUrlInput` — i.e., jobs carry ORIGINAL urls. Per
 * TASK-008 AC #6 the producer's SSRF check is literally "starts with
 * 'https://web.archive.org/'", which only holds if ProxyService is
 * later rewired to enqueue the rewritten Wayback URL. When ProxyService
 * lands in TASK-009 we may need to either accept original URLs here
 * and move the Wayback-prefix assertion to the HTTP boundary, or have
 * the producer compose the Wayback URL before enqueue.
 */
const WAYBACK_ARCHIVE_PREFIX = "https://web.archive.org/";

interface StatusError extends Error {
	status: number;
}

const ssrfError = (url: string): StatusError =>
	Object.assign(new Error(`SSRF: refusing non-Wayback URL ${url}`), { status: 400 });

/**
 * BullMQ producer for archive jobs.
 *
 * - `enqueueExactAndWait` is BLOCKING — caller awaits the foreground
 *   download via `QueueEvents.waitUntilFinished`.
 * - `enqueueDomainCrawl` is FIRE-AND-FORGET — caller does not await
 *   completion; suppressed entirely when `domainCrawlEnabled` is false.
 */
export class ArchiveJobClient {
	constructor(
		private readonly exactQueue: Queue<ExactUrlJob>,
		private readonly crawlQueue: Queue<DomainCrawlJob>,
		private readonly exactEvents: QueueEvents,
		private readonly logger: pino.Logger,
		private readonly domainCrawlEnabled: boolean,
	) {}

	async enqueueExactAndWait(url: string, time: string): Promise<void> {
		if (!url.startsWith(WAYBACK_ARCHIVE_PREFIX)) {
			throw ssrfError(url);
		}
		const jobId = exactJobId(url, time);
		const job = await this.exactQueue.add("exact", { url, time }, { ...EXACT_JOB_OPTS, jobId });
		this.logger.debug(
			{ jobId: job.id, url, time },
			"[archive-job-client] enqueued exact, awaiting",
		);
		await job.waitUntilFinished(this.exactEvents, WAIT_TIMEOUT_MS);
	}

	async enqueueDomainCrawl(host: string, time: string): Promise<void> {
		if (!this.domainCrawlEnabled) return;
		const jobId = crawlJobId(host, time);
		await this.crawlQueue.add("crawl", { host, time }, { ...CRAWL_JOB_OPTS, jobId });
		this.logger.debug({ jobId, host, time }, "[archive-job-client] enqueued crawl");
	}
}
