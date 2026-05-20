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

function makeEvents(): Record<string, unknown> {
	return {};
}

function makeClient(
	overrides: {
		exactQueue?: FakeQueue;
		crawlQueue?: FakeQueue;
		domainCrawlEnabled?: boolean;
		logger?: pino.Logger;
	} = {},
): {
	client: ArchiveJobClient;
	exactQueue: FakeQueue;
	crawlQueue: FakeQueue;
	exactEvents: Record<string, unknown>;
	logger: pino.Logger;
} {
	const exactQueue = overrides.exactQueue ?? makeFakeQueue();
	const crawlQueue = overrides.crawlQueue ?? makeFakeQueue();
	const exactEvents = makeEvents();
	const logger = overrides.logger ?? makeLogger();
	const domainCrawlEnabled = overrides.domainCrawlEnabled ?? true;
	const client = new ArchiveJobClient(
		// Cast to the bullmq types — fakes intentionally implement only the
		// methods the client touches.
		exactQueue as unknown as ConstructorParameters<typeof ArchiveJobClient>[0],
		crawlQueue as unknown as ConstructorParameters<typeof ArchiveJobClient>[1],
		exactEvents as unknown as ConstructorParameters<typeof ArchiveJobClient>[2],
		logger,
		domainCrawlEnabled,
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
