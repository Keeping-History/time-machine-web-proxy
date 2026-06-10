// Tests for src/clients/archive-job-client.ts (TASK-008).
//
// We do not need the real bullmq runtime — only its types. The tests pass
// fakes for Queue, QueueEvents, and Job that implement the methods the
// client uses (`add`, `waitUntilFinished`). This matches the pattern from
// tests/queue/archive-worker.test.ts where the bullmq module itself is
// mocked.

import { createHash } from "node:crypto";
import type pino from "pino";
import { ArchiveJobClient } from "../../src/clients/archive-job-client";

// --- Fakes -------------------------------------------------------------------

interface FakeJob {
	id: string | undefined;
	waitUntilFinished: jest.Mock;
}

interface FakeQueue {
	add: jest.Mock;
	addBulk?: jest.Mock;
}

type AddArgs = [string, Record<string, unknown>, Record<string, unknown>];

function makeFakeJob(id?: string): FakeJob {
	return {
		id,
		waitUntilFinished: jest.fn().mockResolvedValue(undefined),
	};
}

function makeFakeQueue(): FakeQueue {
	return {
		add: jest.fn(async (_name: string, _data: unknown, opts: { jobId?: string }) =>
			makeFakeJob(opts?.jobId),
		),
		addBulk: jest.fn().mockResolvedValue([]),
	};
}

function makeLogger(): pino.Logger {
	return {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	} as unknown as pino.Logger;
}

interface FakeEvents {
	on: jest.Mock;
	off: jest.Mock;
	handlers: Record<string, Array<(args: unknown) => void>>;
	emit(event: string, payload: unknown): void;
}

function makeEvents(): FakeEvents {
	const handlers: Record<string, Array<(args: unknown) => void>> = {};
	const events: FakeEvents = {
		handlers,
		on: jest.fn((event: string, handler: (args: unknown) => void) => {
			(handlers[event] ??= []).push(handler);
		}),
		off: jest.fn((event: string, handler: (args: unknown) => void) => {
			handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
		}),
		emit(event, payload) {
			for (const h of handlers[event] ?? []) h(payload);
		},
	};
	return events;
}

function makeClient(
	overrides: {
		exactQueue?: FakeQueue;
		crawlQueue?: FakeQueue;
		chunkQueue?: FakeQueue;
		domainCrawlEnabled?: boolean;
		logger?: pino.Logger;
	} = {},
): {
	client: ArchiveJobClient;
	exactQueue: FakeQueue;
	crawlQueue: FakeQueue;
	chunkQueue: FakeQueue;
	exactEvents: FakeEvents;
	logger: pino.Logger;
} {
	const exactQueue = overrides.exactQueue ?? makeFakeQueue();
	const crawlQueue = overrides.crawlQueue ?? makeFakeQueue();
	const chunkQueue = overrides.chunkQueue ?? makeFakeQueue();
	const exactEvents = makeEvents();
	const logger = overrides.logger ?? makeLogger();
	const domainCrawlEnabled = overrides.domainCrawlEnabled ?? true;
	const client = new ArchiveJobClient(
		// Cast to the bullmq types — fakes intentionally implement only the
		// methods the client touches.
		exactQueue as unknown as ConstructorParameters<typeof ArchiveJobClient>[0],
		crawlQueue as unknown as ConstructorParameters<typeof ArchiveJobClient>[1],
		chunkQueue as unknown as ConstructorParameters<typeof ArchiveJobClient>[2],
		exactEvents as unknown as ConstructorParameters<typeof ArchiveJobClient>[3],
		logger,
		domainCrawlEnabled,
	);
	return { client, exactQueue, crawlQueue, chunkQueue, exactEvents, logger };
}

// The client accepts the ORIGINAL target URL (the worker in TASK-007 builds
// the Wayback request internally). The SSRF policy lives upstream in
// TimeMachineService.validateTargetUrl — see ArchiveJobClient class doc.
const TARGET_URL = "http://example.com/";
const TIME = "20200101000000";

const expectedExactJobId = (url: string, time: string): string =>
	`e-${createHash("sha256").update(`${url}|${time}`).digest("hex").slice(0, 16)}`;
const expectedCrawlJobId = (host: string, time: string): string =>
	`c-${createHash("sha256").update(`${host}|${time}`).digest("hex").slice(0, 16)}`;

// --- enqueueExactAndWait -----------------------------------------------------

describe("ArchiveJobClient.enqueueExactAndWait", () => {
	it("adds an 'exact' job and resolves once waitUntilFinished resolves", async () => {
		const { client, exactQueue } = makeClient();
		await expect(client.enqueueExactAndWait(TARGET_URL, TIME)).resolves.toBeUndefined();
		expect(exactQueue.add).toHaveBeenCalledTimes(1);
		const [name, data] = exactQueue.add.mock.calls[0] as AddArgs;
		expect(name).toBe("exact");
		expect(data).toEqual({ url: TARGET_URL, time: TIME });
	});

	it("uses a deterministic jobId of form 'e-' + sha256(url|time).slice(0,16)", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		const [, , opts] = exactQueue.add.mock.calls[0] as AddArgs;
		const jobId = opts.jobId as string;
		expect(jobId).toMatch(/^e-[0-9a-f]{16}$/);
		expect(jobId).toBe(expectedExactJobId(TARGET_URL, TIME));
	});

	it("produces the SAME jobId for two identical (url, time) pairs (dedup)", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		expect(exactQueue.add).toHaveBeenCalledTimes(2);
		const idA = (exactQueue.add.mock.calls[0] as AddArgs)[2].jobId;
		const idB = (exactQueue.add.mock.calls[1] as AddArgs)[2].jobId;
		expect(idA).toBe(idB);
	});

	it("produces a DIFFERENT jobId when time changes", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		await client.enqueueExactAndWait(TARGET_URL, "20210101000000");
		const idA = (exactQueue.add.mock.calls[0] as AddArgs)[2].jobId;
		const idB = (exactQueue.add.mock.calls[1] as AddArgs)[2].jobId;
		expect(idA).not.toBe(idB);
	});

	it("produces a DIFFERENT jobId when url changes", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		await client.enqueueExactAndWait("http://other.com/", TIME);
		const idA = (exactQueue.add.mock.calls[0] as AddArgs)[2].jobId;
		const idB = (exactQueue.add.mock.calls[1] as AddArgs)[2].jobId;
		expect(idA).not.toBe(idB);
	});

	it("passes the exact JobsOptions: attempts/backoff/removeOnComplete/removeOnFail", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		const [, , opts] = exactQueue.add.mock.calls[0] as AddArgs;
		expect(opts.attempts).toBe(3);
		expect(opts.backoff).toEqual({ type: "exponential", delay: 2000 });
		expect(opts.removeOnComplete).toEqual({ count: 100, age: 3600 });
		expect(opts.removeOnFail).toBe(1000);
	});

	it("propagates failures by rejecting when waitUntilFinished rejects", async () => {
		const failingJob: FakeJob = {
			id: "e-abc",
			waitUntilFinished: jest.fn().mockRejectedValue(new Error("job failed")),
		};
		const exactQueue: FakeQueue = {
			add: jest.fn().mockResolvedValue(failingJob),
		};
		const { client } = makeClient({ exactQueue });
		await expect(client.enqueueExactAndWait(TARGET_URL, TIME)).rejects.toThrow("job failed");
	});

	it("invokes waitUntilFinished with the exactEvents instance and the WAIT_TIMEOUT_MS (200_000)", async () => {
		const job: FakeJob = makeFakeJob("e-xyz");
		const exactQueue: FakeQueue = { add: jest.fn().mockResolvedValue(job) };
		const { client, exactEvents } = makeClient({ exactQueue });
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		expect(job.waitUntilFinished).toHaveBeenCalledTimes(1);
		expect(job.waitUntilFinished).toHaveBeenCalledWith(exactEvents, 200_000);
	});

	it("accepts http:// and https:// original target URLs (transport layer does not enforce policy)", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExactAndWait("http://example.com/", TIME);
		await client.enqueueExactAndWait("https://example.com/", TIME);
		expect(exactQueue.add).toHaveBeenCalledTimes(2);
	});

	it("forwards QueueEvents 'progress' to the onProgress callback (filtered by this job's id)", async () => {
		const expectedId = expectedExactJobId(TARGET_URL, TIME);
		const job: FakeJob = makeFakeJob(expectedId);
		const exactQueue: FakeQueue = { add: jest.fn().mockResolvedValue(job) };
		const { client, exactEvents } = makeClient({ exactQueue });
		const onProgress = jest.fn();
		// Resolve the wait only after we've had a chance to emit progress.
		let resolveWait: () => void = () => undefined;
		job.waitUntilFinished.mockImplementation(
			() =>
				new Promise<void>((res) => {
					resolveWait = res;
				}),
		);
		const pending = client.enqueueExactAndWait(TARGET_URL, TIME, onProgress);
		await Promise.resolve();
		const progress = {
			stage: "resolved",
			jobId: expectedId,
			queue: "archive-exact" as const,
			ts: 1,
			resolved: "20200115000000",
		};
		exactEvents.emit("progress", { jobId: expectedId, data: progress });
		expect(onProgress).toHaveBeenCalledWith(progress);
		resolveWait();
		await pending;
	});

	it("does NOT forward progress events for OTHER jobs sharing the same QueueEvents stream", async () => {
		const ownId = expectedExactJobId(TARGET_URL, TIME);
		const job: FakeJob = makeFakeJob(ownId);
		const exactQueue: FakeQueue = { add: jest.fn().mockResolvedValue(job) };
		const { client, exactEvents } = makeClient({ exactQueue });
		const onProgress = jest.fn();
		let resolveWait: () => void = () => undefined;
		job.waitUntilFinished.mockImplementation(
			() =>
				new Promise<void>((res) => {
					resolveWait = res;
				}),
		);
		const pending = client.enqueueExactAndWait(TARGET_URL, TIME, onProgress);
		await Promise.resolve();
		exactEvents.emit("progress", {
			jobId: "some-other-job",
			data: { stage: "resolved", jobId: "some-other-job", queue: "archive-exact", ts: 1 },
		});
		expect(onProgress).not.toHaveBeenCalled();
		resolveWait();
		await pending;
	});

	it("unsubscribes the progress handler after waitUntilFinished resolves", async () => {
		const expectedId = expectedExactJobId(TARGET_URL, TIME);
		const job: FakeJob = makeFakeJob(expectedId);
		const exactQueue: FakeQueue = { add: jest.fn().mockResolvedValue(job) };
		const { client, exactEvents } = makeClient({ exactQueue });
		const onProgress = jest.fn();
		await client.enqueueExactAndWait(TARGET_URL, TIME, onProgress);
		expect(exactEvents.off).toHaveBeenCalledWith("progress", expect.any(Function));
		// After unsubscribe, late emissions must not reach the callback.
		exactEvents.emit("progress", {
			jobId: expectedId,
			data: { stage: "download_done", jobId: expectedId, queue: "archive-exact", ts: 2 },
		});
		expect(onProgress).not.toHaveBeenCalled();
	});

	it("unsubscribes even when waitUntilFinished rejects", async () => {
		const expectedId = expectedExactJobId(TARGET_URL, TIME);
		const job: FakeJob = {
			id: expectedId,
			waitUntilFinished: jest.fn().mockRejectedValue(new Error("boom")),
		};
		const exactQueue: FakeQueue = { add: jest.fn().mockResolvedValue(job) };
		const { client, exactEvents } = makeClient({ exactQueue });
		const onProgress = jest.fn();
		await expect(client.enqueueExactAndWait(TARGET_URL, TIME, onProgress)).rejects.toThrow("boom");
		expect(exactEvents.off).toHaveBeenCalledWith("progress", expect.any(Function));
	});

	it("ignores progress payloads that don't match the JobProgress shape", async () => {
		const expectedId = expectedExactJobId(TARGET_URL, TIME);
		const job: FakeJob = makeFakeJob(expectedId);
		const exactQueue: FakeQueue = { add: jest.fn().mockResolvedValue(job) };
		const { client, exactEvents } = makeClient({ exactQueue });
		const onProgress = jest.fn();
		let resolveWait: () => void = () => undefined;
		job.waitUntilFinished.mockImplementation(
			() =>
				new Promise<void>((res) => {
					resolveWait = res;
				}),
		);
		const pending = client.enqueueExactAndWait(TARGET_URL, TIME, onProgress);
		await Promise.resolve();
		// Numeric progress (legacy BullMQ shape) — not a JobProgress object.
		exactEvents.emit("progress", { jobId: expectedId, data: 42 });
		exactEvents.emit("progress", { jobId: expectedId, data: null });
		expect(onProgress).not.toHaveBeenCalled();
		resolveWait();
		await pending;
	});

	it("does NOT subscribe to progress events when no onProgress callback is provided", async () => {
		const { client, exactEvents } = makeClient();
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		expect(exactEvents.on).not.toHaveBeenCalledWith("progress", expect.any(Function));
	});
});

// --- enqueueDomainCrawl ------------------------------------------------------

describe("ArchiveJobClient.enqueueDomainCrawl", () => {
	it("adds a 'crawl' job and returns WITHOUT calling waitUntilFinished", async () => {
		const job: FakeJob = makeFakeJob("c-xyz");
		const crawlQueue: FakeQueue = { add: jest.fn().mockResolvedValue(job) };
		const { client } = makeClient({ crawlQueue });
		await client.enqueueDomainCrawl("example.com", TIME);
		expect(crawlQueue.add).toHaveBeenCalledTimes(1);
		const [name, data] = crawlQueue.add.mock.calls[0] as AddArgs;
		expect(name).toBe("crawl");
		expect(data).toEqual({ host: "example.com", time: TIME });
		expect(job.waitUntilFinished).not.toHaveBeenCalled();
	});

	it("uses a deterministic jobId of form 'c-' + sha256(host|time).slice(0,16)", async () => {
		const { client, crawlQueue } = makeClient();
		await client.enqueueDomainCrawl("example.com", TIME);
		const [, , opts] = crawlQueue.add.mock.calls[0] as AddArgs;
		const jobId = opts.jobId as string;
		expect(jobId).toMatch(/^c-[0-9a-f]{16}$/);
		expect(jobId).toBe(expectedCrawlJobId("example.com", TIME));
	});

	it("passes the same JobsOptions shape as exact (attempts/backoff/retention)", async () => {
		const { client, crawlQueue } = makeClient();
		await client.enqueueDomainCrawl("example.com", TIME);
		const [, , opts] = crawlQueue.add.mock.calls[0] as AddArgs;
		expect(opts.attempts).toBe(3);
		expect(opts.backoff).toEqual({ type: "exponential", delay: 2000 });
		expect(opts.removeOnComplete).toEqual({ count: 100, age: 3600 });
		expect(opts.removeOnFail).toBe(1000);
	});

	it("is a no-op when domainCrawlEnabled is false", async () => {
		const { client, crawlQueue } = makeClient({ domainCrawlEnabled: false });
		await expect(client.enqueueDomainCrawl("example.com", TIME)).resolves.toBeUndefined();
		expect(crawlQueue.add).not.toHaveBeenCalled();
	});
});

// --- enqueueExact ------------------------------------------------------------

describe("ArchiveJobClient.enqueueExact", () => {
	it("adds an 'exact' job with deterministic jobId", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExact(TARGET_URL, TIME);
		expect(exactQueue.add).toHaveBeenCalledTimes(1);
		const [name, data, opts] = exactQueue.add.mock.calls[0] as AddArgs;
		expect(name).toBe("exact");
		expect(data).toEqual({ url: TARGET_URL, time: TIME });
		expect(opts.jobId).toBe(expectedExactJobId(TARGET_URL, TIME));
	});

	it("does NOT call waitUntilFinished — fire-and-forget", async () => {
		const job = makeFakeJob("e-abc");
		const exactQueue: FakeQueue = { add: jest.fn().mockResolvedValue(job) };
		const { client } = makeClient({ exactQueue });
		await client.enqueueExact(TARGET_URL, TIME);
		expect(job.waitUntilFinished).not.toHaveBeenCalled();
	});

	it("uses the same EXACT_JOB_OPTS as enqueueExactAndWait", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExact(TARGET_URL, TIME);
		const [, , opts] = exactQueue.add.mock.calls[0] as AddArgs;
		expect(opts.attempts).toBe(3);
		expect(opts.backoff).toEqual({ type: "exponential", delay: 2000 });
		expect(opts.removeOnComplete).toEqual({ count: 100, age: 3600 });
		expect(opts.removeOnFail).toBe(1000);
	});

	it("emits a debug log with jobId, url, time", async () => {
		const logger = makeLogger();
		const { client } = makeClient({ logger });
		await client.enqueueExact(TARGET_URL, TIME);
		expect(logger.debug).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: expectedExactJobId(TARGET_URL, TIME),
				url: TARGET_URL,
				time: TIME,
			}),
			expect.stringContaining("crawl fan-out"),
		);
	});
});

// --- enqueueCrawlChunks -------------------------------------------------------

const expectedChunkJobId = (host: string, time: string, page: number): string =>
	`cc-${createHash("sha256").update(`${host}|${time}|${page}`).digest("hex").slice(0, 16)}`;

describe("ArchiveJobClient.enqueueCrawlChunks", () => {
	it("adds one chunk job per page (pages 0..N-1) when totalPages=3", async () => {
		const { client, chunkQueue } = makeClient();
		await client.enqueueCrawlChunks("apple.com", TIME, 3, 1000);
		expect(chunkQueue.addBulk!).toHaveBeenCalledTimes(1);
		const jobs = chunkQueue.addBulk!.mock.calls[0][0] as Array<{ name: string; data: Record<string, unknown>; opts: Record<string, unknown> }>;
		expect(jobs).toHaveLength(3);
		for (let page = 0; page < 3; page++) {
			expect(jobs[page].name).toBe("crawl-chunk");
			expect(jobs[page].data).toMatchObject({ host: "apple.com", time: TIME, page });
			expect(jobs[page].opts.jobId).toBe(expectedChunkJobId("apple.com", TIME, page));
		}
	});

	it("uses deterministic jobId of form 'cc-' + sha256(host|time|page).slice(0,16)", async () => {
		const { client, chunkQueue } = makeClient();
		await client.enqueueCrawlChunks("apple.com", TIME, 1, 1000);
		const jobs = chunkQueue.addBulk!.mock.calls[0][0] as Array<{ opts: Record<string, unknown> }>;
		const jobId = jobs[0].opts.jobId as string;
		expect(jobId).toMatch(/^cc-[0-9a-f]{16}$/);
		expect(jobId).toBe(expectedChunkJobId("apple.com", TIME, 0));
	});

	it("clips to maxFanout when totalPages exceeds it", async () => {
		const { client, chunkQueue } = makeClient();
		await client.enqueueCrawlChunks("apple.com", TIME, 10, 3);
		const jobs = chunkQueue.addBulk!.mock.calls[0][0] as unknown[];
		expect(jobs).toHaveLength(3);
	});

	it("is a no-op when domainCrawlEnabled is false", async () => {
		const { client, chunkQueue } = makeClient({ domainCrawlEnabled: false });
		await expect(
			client.enqueueCrawlChunks("apple.com", TIME, 5, 1000),
		).resolves.toBeUndefined();
		expect(chunkQueue.addBulk!).not.toHaveBeenCalled();
	});

	it("enqueues 0 jobs when totalPages is 0", async () => {
		const { client, chunkQueue } = makeClient();
		await client.enqueueCrawlChunks("apple.com", TIME, 0, 1000);
		expect(chunkQueue.addBulk!).not.toHaveBeenCalled();
	});

	it("passes the CHUNK_JOB_OPTS: attempts/backoff/removeOnComplete/removeOnFail", async () => {
		const { client, chunkQueue } = makeClient();
		await client.enqueueCrawlChunks("apple.com", TIME, 1, 1000);
		const jobs = chunkQueue.addBulk!.mock.calls[0][0] as Array<{ opts: Record<string, unknown> }>;
		const opts = jobs[0].opts;
		expect(opts.attempts).toBe(3);
		expect(opts.backoff).toEqual({ type: "exponential", delay: 2000 });
		expect(opts.removeOnComplete).toEqual({ count: 100, age: 3600 });
		expect(opts.removeOnFail).toBe(1000);
	});
});
