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
	priority: number;
	waitUntilFinished: jest.Mock;
	changePriority: jest.Mock;
}

interface FakeQueue {
	add: jest.Mock;
	addBulk?: jest.Mock;
}

type AddArgs = [string, Record<string, unknown>, Record<string, unknown>];

function makeFakeJob(id?: string, priority = 0): FakeJob {
	return {
		id,
		priority,
		waitUntilFinished: jest.fn().mockResolvedValue(undefined),
		changePriority: jest.fn().mockResolvedValue(undefined),
	};
}

function makeFakeQueue(): FakeQueue {
	return {
		// Mirror BullMQ: the returned job carries the priority this add passed.
		add: jest.fn(async (_name: string, _data: unknown, opts: { jobId?: string; priority?: number }) =>
			makeFakeJob(opts?.jobId, opts?.priority ?? 0),
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

// Default crawl priority used by makeClient unless a test overrides it. The
// production default is 10; the value only needs to be > FOREGROUND_PRIORITY (1).
const CRAWL_PRIORITY = 10;

function makeClient(
	overrides: {
		exactQueue?: FakeQueue;
		crawlQueue?: FakeQueue;
		domainCrawlEnabled?: boolean;
		crawlJobPriority?: number;
		logger?: pino.Logger;
	} = {},
): {
	client: ArchiveJobClient;
	exactQueue: FakeQueue;
	crawlQueue: FakeQueue;
	exactEvents: FakeEvents;
	logger: pino.Logger;
} {
	const exactQueue = overrides.exactQueue ?? makeFakeQueue();
	const crawlQueue = overrides.crawlQueue ?? makeFakeQueue();
	const exactEvents = makeEvents();
	const logger = overrides.logger ?? makeLogger();
	const domainCrawlEnabled = overrides.domainCrawlEnabled ?? true;
	const crawlJobPriority = overrides.crawlJobPriority ?? CRAWL_PRIORITY;
	const client = new ArchiveJobClient(
		// Cast to the bullmq types — fakes intentionally implement only the
		// methods the client touches.
		exactQueue as unknown as ConstructorParameters<typeof ArchiveJobClient>[0],
		crawlQueue as unknown as ConstructorParameters<typeof ArchiveJobClient>[1],
		exactEvents as unknown as ConstructorParameters<typeof ArchiveJobClient>[2],
		logger,
		domainCrawlEnabled,
		crawlJobPriority,
	);
	return { client, exactQueue, crawlQueue, exactEvents, logger };
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
			priority: 0,
			waitUntilFinished: jest.fn().mockRejectedValue(new Error("job failed")),
			changePriority: jest.fn().mockResolvedValue(undefined),
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
			priority: 0,
			waitUntilFinished: jest.fn().mockRejectedValue(new Error("boom")),
			changePriority: jest.fn().mockResolvedValue(undefined),
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
			expect.stringContaining("enqueued exact"),
		);
	});
});

// --- enqueueExact crawl meta --------------------------------------------------

describe("ArchiveJobClient.enqueueExact (crawl meta)", () => {
	it("includes crawl provenance in the job data when provided", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExact("https://example.com/US/", TIME, {
			rootHost: "example.com",
			rootTime: TIME,
			depth: 2,
		});
		const data = exactQueue.add!.mock.calls[0][1] as Record<string, unknown>;
		expect(data).toMatchObject({
			url: "https://example.com/US/",
			time: TIME,
			crawl: { rootHost: "example.com", rootTime: TIME, depth: 2 },
		});
	});

	it("omits the crawl field for a plain foreground fetch", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExact("https://example.com/US/", TIME);
		const data = exactQueue.add!.mock.calls[0][1] as Record<string, unknown>;
		expect(data.crawl).toBeUndefined();
	});
});

// --- priority ordering: crawl-derived vs real-time ---------------------------
//
// Real-time (foreground) exact jobs must outrank exact jobs created as part of
// a domain crawl, so a backlog of crawl-discovered links can't starve a live
// request. BullMQ uses lower-number = higher priority, so foreground jobs get
// priority 1 (top) and crawl-derived jobs get the configured (higher) value.

describe("ArchiveJobClient priority (crawl-derived vs real-time)", () => {
	it("tags a crawl-derived exact job with the configured low crawl priority", async () => {
		const { client, exactQueue } = makeClient({ crawlJobPriority: 10 });
		await client.enqueueExact("https://example.com/US/", TIME, {
			rootHost: "example.com",
			rootTime: TIME,
			depth: 1,
		});
		const [, , opts] = exactQueue.add.mock.calls[0] as AddArgs;
		expect(opts.priority).toBe(10);
	});

	it("honors a different configured crawl priority", async () => {
		const { client, exactQueue } = makeClient({ crawlJobPriority: 50 });
		await client.enqueueExact("https://example.com/US/", TIME, {
			rootHost: "example.com",
			rootTime: TIME,
			depth: 1,
		});
		const [, , opts] = exactQueue.add.mock.calls[0] as AddArgs;
		expect(opts.priority).toBe(50);
	});

	it("does NOT assign a crawl priority to a fire-and-forget exact without crawl meta", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExact(TARGET_URL, TIME);
		const [, , opts] = exactQueue.add.mock.calls[0] as AddArgs;
		expect(opts.priority).toBeUndefined();
	});

	it("adds a real-time (enqueueExactAndWait) job at the top priority (1)", async () => {
		const { client, exactQueue } = makeClient();
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		const [, , opts] = exactQueue.add.mock.calls[0] as AddArgs;
		expect(opts.priority).toBe(1);
	});

	it("promotes the job to top priority via changePriority (covers dedup onto a queued low-priority crawl job)", async () => {
		// Simulate the collision: the jobId already exists as a crawl job at
		// priority 10, so add() returns that existing job unchanged.
		const existing = makeFakeJob(expectedExactJobId(TARGET_URL, TIME), 10);
		const exactQueue: FakeQueue = { add: jest.fn().mockResolvedValue(existing) };
		const { client } = makeClient({ exactQueue });
		await client.enqueueExactAndWait(TARGET_URL, TIME);
		expect(existing.changePriority).toHaveBeenCalledWith({ priority: 1 });
	});

	it("still resolves when changePriority throws (e.g. job already active)", async () => {
		const active = makeFakeJob(expectedExactJobId(TARGET_URL, TIME), 10);
		active.changePriority.mockRejectedValue(new Error("not in a priority state"));
		const exactQueue: FakeQueue = { add: jest.fn().mockResolvedValue(active) };
		const { client } = makeClient({ exactQueue });
		await expect(client.enqueueExactAndWait(TARGET_URL, TIME)).resolves.toBeUndefined();
		expect(active.waitUntilFinished).toHaveBeenCalledTimes(1);
	});
});
