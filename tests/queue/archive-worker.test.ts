// Tests for src/queue/archive-worker.ts.
//
// The exact worker calls `directClient.fetchAtRequestedTime(url, time)` and
// lets Wayback's `im_` endpoint pick the nearest capture server-side — the
// CDX snapshot-resolver is no longer involved. The crawl worker enumerates
// URLs via a passed-in cdxFetch, then downloads each via
// `fetchAtResolvedTime`. Mocks stay tight: directClient and cdxFetch are
// jest.fn()s wired through the public StartArchiveWorkersOpts contract.

// --- bullmq harness ----------------------------------------------------------

interface CapturedWorker {
	name: string;
	processor: (job: unknown) => Promise<unknown>;
	opts: Record<string, unknown>;
	on: jest.Mock;
	rateLimit: jest.Mock;
}

const workerInstances: CapturedWorker[] = [];
const rateLimitErrorMock = jest.fn(() => new Error("RateLimitError"));

const WorkerMock = jest
	.fn()
	.mockImplementation(
		(
			name: string,
			processor: (job: unknown) => Promise<unknown>,
			opts: Record<string, unknown>,
		): CapturedWorker => {
			const instance: CapturedWorker = {
				name,
				processor,
				opts,
				on: jest.fn(),
				rateLimit: jest.fn().mockResolvedValue(undefined),
			};
			workerInstances.push(instance);
			return instance;
		},
	) as unknown as jest.Mock & { RateLimitError: jest.Mock };
(WorkerMock as unknown as { RateLimitError: jest.Mock }).RateLimitError = rateLimitErrorMock;

jest.mock("bullmq", () => ({
	__esModule: true,
	Worker: WorkerMock,
	QueueEvents: jest.fn(),
}));

// --- Imports (after mocks) ---------------------------------------------------

import type pino from "pino";
import type { RequestedResult, ResolvedResult } from "../../src/clients/wayback-direct-client";
import {
	type ArchiveDirectClient,
	attachQueueLogger,
	startArchiveWorkers,
} from "../../src/queue/archive-worker";
import { QUEUE_CRAWL, QUEUE_EXACT } from "../../src/queue/jobs";

// --- Helpers -----------------------------------------------------------------

function makeLogger(): pino.Logger {
	const stub = {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
		child: jest.fn(),
	};
	stub.child.mockReturnValue(stub);
	return stub as unknown as pino.Logger;
}

function makeCache(dir = "/cache"): {
	cacheDirForJob: jest.Mock;
	writeFile: jest.Mock;
	writeContentTypeSidecar: jest.Mock;
	writeNotFoundSentinel: jest.Mock;
	writeResolvedTimeSidecar: jest.Mock;
	lookup: jest.Mock;
} {
	return {
		cacheDirForJob: jest.fn((time: string, host: string) => `${dir}/v2/${time}/${host}`),
		writeFile: jest.fn().mockResolvedValue(undefined),
		writeContentTypeSidecar: jest.fn().mockResolvedValue(undefined),
		writeNotFoundSentinel: jest.fn().mockResolvedValue(undefined),
		writeResolvedTimeSidecar: jest.fn().mockResolvedValue(undefined),
		// Default to a non-null hit so the exact worker's post-download
		// sanity check passes. Tests that exercise the "no usable file" path
		// override this explicitly.
		lookup: jest.fn().mockResolvedValue({
			absPath: `${dir}/v2/anytime/anyhost/index.html`,
			contentType: "text/html",
		}),
	};
}

function defaultDirectClient(): {
	fetchAtRequestedTime: jest.Mock;
	fetchAtResolvedTime: jest.Mock;
} {
	return {
		fetchAtRequestedTime: jest.fn(
			async (_url: string, _ts: string): Promise<RequestedResult> => ({
				outcome: "ok" as const,
				body: Buffer.from("<html></html>"),
				contentType: "text/html",
				resolvedTime: "20200115000000",
			}),
		),
		fetchAtResolvedTime: jest.fn(
			async (_url: string, _ts: string): Promise<ResolvedResult> => ({
				outcome: "ok" as const,
				body: Buffer.from("<html></html>"),
				contentType: "text/html",
			}),
		),
	};
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function emptyCdxFetch(): jest.Mock {
	return jest.fn(async () => jsonResponse([]));
}

function baseOpts(
	overrides: Record<string, unknown> = {},
): Parameters<typeof startArchiveWorkers>[0] {
	const cache = makeCache();
	return {
		connection: { host: "localhost" } as unknown as Parameters<
			typeof startArchiveWorkers
		>[0]["connection"],
		cache: cache as unknown as Parameters<typeof startArchiveWorkers>[0]["cache"],
		directClient: defaultDirectClient() as unknown as ArchiveDirectClient,
		cdxFetch: emptyCdxFetch() as unknown as typeof fetch,
		logger: makeLogger(),
		bullmqPrefix: "tm",
		workerConcurrency: 2,
		workerRateLimitPerSec: 1,
		...overrides,
	};
}

function findWorker(name: string): CapturedWorker {
	const w = workerInstances.find((wi) => wi.name === name);
	if (!w) throw new Error(`Worker for queue '${name}' not captured`);
	return w;
}

beforeEach(() => {
	WorkerMock.mockClear();
	rateLimitErrorMock.mockClear();
	workerInstances.length = 0;
});

// --- startArchiveWorkers: returned shape + Worker construction ---------------

describe("startArchiveWorkers", () => {
	it("returns an object with `exact` and `crawl` Worker instances", () => {
		const result = startArchiveWorkers(baseOpts());
		expect(result.exact).toBeDefined();
		expect(result.crawl).toBeDefined();
	});

	it("constructs two Workers, one per queue, in the correct order", () => {
		startArchiveWorkers(baseOpts());
		expect(WorkerMock).toHaveBeenCalledTimes(2);
		expect(workerInstances.map((w) => w.name)).toEqual([QUEUE_EXACT, QUEUE_CRAWL]);
	});

	it("passes the BullMQ prefix to BOTH Workers (critical — default 'bull' breaks dispatch)", () => {
		startArchiveWorkers(baseOpts({ bullmqPrefix: "tm" }));
		expect(findWorker(QUEUE_EXACT).opts.prefix).toBe("tm");
		expect(findWorker(QUEUE_CRAWL).opts.prefix).toBe("tm");
	});

	it("threads a non-default prefix through unchanged", () => {
		startArchiveWorkers(baseOpts({ bullmqPrefix: "custom-ns" }));
		expect(findWorker(QUEUE_EXACT).opts.prefix).toBe("custom-ns");
		expect(findWorker(QUEUE_CRAWL).opts.prefix).toBe("custom-ns");
	});

	it("exact worker uses configured concurrency, crawl worker is concurrency: 1", () => {
		startArchiveWorkers(baseOpts({ workerConcurrency: 4 }));
		expect(findWorker(QUEUE_EXACT).opts.concurrency).toBe(4);
		expect(findWorker(QUEUE_CRAWL).opts.concurrency).toBe(1);
	});

	it("applies the rate limiter to BOTH workers with duration: 1000ms", () => {
		startArchiveWorkers(baseOpts({ workerRateLimitPerSec: 1 }));
		expect(findWorker(QUEUE_EXACT).opts.limiter).toEqual({ max: 1, duration: 1000 });
		expect(findWorker(QUEUE_CRAWL).opts.limiter).toEqual({ max: 1, duration: 1000 });
	});

	it("crawl worker sets lockDuration / stalledInterval / maxStalledCount for long crawls", () => {
		startArchiveWorkers(baseOpts());
		const crawl = findWorker(QUEUE_CRAWL);
		expect(crawl.opts.lockDuration).toBe(120_000);
		expect(crawl.opts.stalledInterval).toBe(30_000);
		expect(crawl.opts.maxStalledCount).toBe(2);
	});

	it("registers a 'failed' event listener on each worker", () => {
		startArchiveWorkers(baseOpts());
		expect(findWorker(QUEUE_EXACT).on).toHaveBeenCalledWith("failed", expect.any(Function));
		expect(findWorker(QUEUE_CRAWL).on).toHaveBeenCalledWith("failed", expect.any(Function));
	});
});

// --- Progress emission -------------------------------------------------------

describe("worker progress emission", () => {
	function makeJob(
		id: string,
		data: Record<string, unknown>,
		token = "tk",
	): {
		id: string;
		data: Record<string, unknown>;
		token: string;
		updateProgress: jest.Mock;
		extendLock?: jest.Mock;
	} {
		return {
			id,
			data,
			token,
			updateProgress: jest.fn().mockResolvedValue(undefined),
			extendLock: jest.fn().mockResolvedValue(0),
		};
	}

	function progressStages(updateProgress: jest.Mock): string[] {
		return updateProgress.mock.calls.map((c) => (c[0] as { stage: string }).stage);
	}

	it("exact processor emits picked_up → download_start → download_file → download_done on ok", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e1", { url: "https://example.com/", time: "20200101000000" });
		await worker.processor(job);
		expect(progressStages(job.updateProgress)).toEqual([
			"picked_up",
			"download_start",
			"download_file",
			"download_done",
		]);
	});

	it("exact processor stops at download_start when direct fetch returns not_found", async () => {
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({ outcome: "not_found" as const })),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ directClient }));
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e-nf", { url: "https://example.com/gone", time: "20200101000000" });
		await worker.processor(job);
		// not_found is terminal: sentinel written, no download_done.
		expect(progressStages(job.updateProgress)).toEqual(["picked_up", "download_start"]);
	});

	it("exact processor emits error stage before re-throwing on fallback", async () => {
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "fallback" as const,
				reason: "boom",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ directClient }));
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e3", { url: "https://example.com/", time: "20200101000000" });
		await expect(worker.processor(job)).rejects.toThrow(/boom/);
		const stages = progressStages(job.updateProgress);
		expect(stages).toContain("error");
		expect(stages[stages.length - 1]).toBe("error");
		const errCall = job.updateProgress.mock.calls.find(
			(c) => (c[0] as { stage: string }).stage === "error",
		);
		expect((errCall?.[0] as { error?: string }).error).toMatch(/boom/);
	});

	it("download_done payload carries the resolvedTime extracted from the im_ redirect", async () => {
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "ok" as const,
				body: Buffer.from("ok"),
				contentType: "text/html",
				resolvedTime: "20200115000000",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ directClient }));
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e-payload", {
			url: "https://example.com/",
			time: "20200101000000",
		});
		await worker.processor(job);
		const doneCall = job.updateProgress.mock.calls.find(
			(c) => (c[0] as { stage: string }).stage === "download_done",
		);
		expect(doneCall?.[0]).toMatchObject({
			stage: "download_done",
			queue: QUEUE_EXACT,
			jobId: "e-payload",
			url: "https://example.com/",
			time: "20200101000000",
			resolved: "20200115000000",
		});
	});

	it("crawl processor emits error stage when all host variants have no CDX captures", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeJob("c1", { host: "example.com", time: "20200101000000" });
		await expect(worker.processor(job)).rejects.toThrow(/no captures/);
		const stages = progressStages(job.updateProgress);
		expect(stages).toContain("picked_up");
		expect(stages[stages.length - 1]).toBe("error");
	});

	it("crawl processor emits error stage before re-throwing on CDX failure", async () => {
		const cdxFetch = jest.fn(async () => new Response("err", { status: 500 }));
		startArchiveWorkers(baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch }));
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeJob("c2", { host: "example.com", time: "20200101000000" });
		await expect(worker.processor(job)).rejects.toThrow(/CDX enumeration 500/);
		const stages = progressStages(job.updateProgress);
		expect(stages[stages.length - 1]).toBe("error");
	});

	it("worker does NOT fail the job when updateProgress throws (observability never blocks correctness)", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e-update-fails", {
			url: "https://example.com/",
			time: "20200101000000",
		});
		job.updateProgress.mockRejectedValue(new Error("redis down"));
		await expect(worker.processor(job)).resolves.toBeUndefined();
	});
});

// --- attachQueueLogger: progress event --------------------------------------

describe("attachQueueLogger progress event", () => {
	it("registers a 'progress' handler that logs the payload at debug", () => {
		const logger = makeLogger();
		const handlers: Record<string, (args: unknown) => void> = {};
		const events = {
			on: jest.fn((event: string, handler: (args: unknown) => void) => {
				handlers[event] = handler;
			}),
		};
		attachQueueLogger(
			"archive-exact",
			events as unknown as Parameters<typeof attachQueueLogger>[1],
			logger,
		);
		expect(events.on).toHaveBeenCalledWith("progress", expect.any(Function));
		handlers.progress({
			jobId: "p1",
			data: {
				stage: "download_done",
				jobId: "p1",
				queue: "archive-exact",
				ts: 1,
				resolved: "20200115000000",
			},
		});
		expect(logger.debug).toHaveBeenCalledWith(
			expect.objectContaining({
				queue: "archive-exact",
				jobId: "p1",
				event: "progress",
				progress: expect.objectContaining({ stage: "download_done" }),
			}),
			expect.stringContaining("progress"),
		);
	});
});

// --- Exact processor ---------------------------------------------------------

describe("exact worker processor", () => {
	it("invokes directClient.fetchAtRequestedTime with the URL and requested timestamp (no CDX)", async () => {
		const cache = makeCache();
		const directClient = defaultDirectClient();
		startArchiveWorkers(baseOpts({ cache, directClient }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j1",
			data: { url: "https://example.com/", time: "20200101000000" },
			token: "tk-1",
		});
		expect(directClient.fetchAtRequestedTime).toHaveBeenCalledTimes(1);
		expect(directClient.fetchAtRequestedTime).toHaveBeenCalledWith(
			"https://example.com/",
			"20200101000000",
		);
		// Worker never touches fetchAtResolvedTime — that path was the CDX-resolved
		// download leg, removed when CDX dependency was dropped.
		expect(directClient.fetchAtResolvedTime).not.toHaveBeenCalled();
	});

	it("writes the response body to cache.writeFile keyed on (url, requested time, body)", async () => {
		const cache = makeCache();
		const body = Buffer.from("page-bytes");
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "ok" as const,
				body,
				contentType: "text/html; charset=utf-8",
				resolvedTime: "20200115000000",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ cache, directClient }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-write",
			data: { url: "https://example.com/about", time: "20200101000000" },
			token: "tk-w",
		});
		expect(cache.writeFile).toHaveBeenCalledWith(
			"https://example.com/about",
			"20200101000000",
			body,
		);
		expect(cache.writeContentTypeSidecar).toHaveBeenCalledWith(
			"https://example.com/about",
			"20200101000000",
			"text/html; charset=utf-8",
		);
	});

	it("derives directory from cache.cacheDirForJob(time, hostname) — preserves 'www.'", async () => {
		const cache = makeCache("/c");
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j2",
			data: { url: "https://www.example.com/about", time: "20200101000000" },
			token: "tk-2",
		});
		// hostname preserves "www." — www.example.com and example.com are
		// stored as separate cache entries.
		expect(cache.cacheDirForJob).toHaveBeenCalledWith("20200101000000", "www.example.com");
	});

	it("rejects invalid ExactUrlJob payloads via the asserter", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "bad",
				data: { url: "ftp://nope", time: "20200101000000" },
				token: "tk",
			}),
		).rejects.toThrow(/Invalid job/);
	});

	it("calls worker.rateLimit(60000) and throws Worker.RateLimitError() on a 429 fallback", async () => {
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "fallback" as const,
				reason: "http-429",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ directClient }));
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "j-429",
				data: { url: "https://example.com/", time: "20200101000000" },
				token: "tk-429",
			}),
		).rejects.toThrow("RateLimitError");
		expect(worker.rateLimit).toHaveBeenCalledWith(60_000);
		expect(rateLimitErrorMock).toHaveBeenCalledTimes(1);
	});

	it("re-throws non-rate-limit fallback errors so BullMQ exponential backoff retries", async () => {
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "fallback" as const,
				reason: "ETIMEDOUT",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ directClient }));
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "j-err",
				data: { url: "https://example.com/", time: "20200101000000" },
				token: "tk-err",
			}),
		).rejects.toThrow(/ETIMEDOUT/);
		expect(worker.rateLimit).not.toHaveBeenCalled();
		expect(rateLimitErrorMock).not.toHaveBeenCalled();
	});

	it("on not_found: writes sentinel, returns cleanly, skips writeFile and post-validation lookup", async () => {
		const cache = makeCache();
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({ outcome: "not_found" as const })),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ cache, directClient }));
		const worker = findWorker(QUEUE_EXACT);
		// Must NOT throw — not_found is the terminal "definitely not in archive"
		// outcome. The proxy will see the sentinel on its next lookup and 404.
		await expect(
			worker.processor({
				id: "j-nf",
				data: { url: "https://example.com/missing", time: "20200101000000" },
				token: "tk-nf",
			}),
		).resolves.toBeUndefined();
		expect(cache.writeNotFoundSentinel).toHaveBeenCalledWith(
			"20200101000000",
			"https://example.com/missing",
		);
		expect(cache.writeFile).not.toHaveBeenCalled();
		expect(cache.lookup).not.toHaveBeenCalled();
	});

	it("writes resolved-time sidecar from the im_ redirect's timestamp", async () => {
		const cache = makeCache();
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "ok" as const,
				body: Buffer.from("ok"),
				contentType: "text/html",
				resolvedTime: "20010822231227",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ cache, directClient }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-sidecar",
			data: { url: "https://example.com/", time: "20010912000000" },
			token: "tk-sc",
		});
		expect(cache.writeResolvedTimeSidecar).toHaveBeenCalledWith(
			"20010912000000",
			"https://example.com/",
			"20010822231227",
		);
	});

	it("does NOT write resolved-time sidecar when the im_ redirect carried no extractable timestamp", async () => {
		const cache = makeCache();
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "ok" as const,
				body: Buffer.from("ok"),
				contentType: "text/html",
				// resolvedTime intentionally omitted
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ cache, directClient }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-no-sidecar",
			data: { url: "https://example.com/", time: "20010912000000" },
			token: "tk-ns",
		});
		expect(cache.writeResolvedTimeSidecar).not.toHaveBeenCalled();
	});

	it("ignores malformed resolvedTime values from the direct client", async () => {
		const cache = makeCache();
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "ok" as const,
				body: Buffer.from("ok"),
				contentType: "text/html",
				resolvedTime: "not-a-timestamp",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ cache, directClient }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-bad-ts",
			data: { url: "https://example.com/", time: "20010912000000" },
			token: "tk-bts",
		});
		// Malformed values must never be written as a sidecar — readResolvedTime
		// on lookup re-validates with the same regex, but the write path must
		// not pollute the cache with non-conforming data.
		expect(cache.writeResolvedTimeSidecar).not.toHaveBeenCalled();
	});

	it("throws when post-download lookup yields no file for THIS (url, time)", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValueOnce(null);
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "j-novalid",
				data: { url: "https://example.com/", time: "20010912000000" },
				token: "tk-nv",
			}),
		).rejects.toThrow(/no usable file/);
	});

	it("does NOT write resolved-time sidecar when direct fetch fails", async () => {
		const cache = makeCache();
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "fallback" as const,
				reason: "download failed",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ cache, directClient }));
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "j-throw",
				data: { url: "https://example.com/", time: "20010912000000" },
				token: "tk-th",
			}),
		).rejects.toThrow(/download failed/);
		expect(cache.writeResolvedTimeSidecar).not.toHaveBeenCalled();
	});

	it("logs warning on not_found", async () => {
		const logger = makeLogger();
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({ outcome: "not_found" as const })),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ logger, directClient }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-warn",
			data: { url: "https://example.com/", time: "20200101000000" },
			token: "tk-warn",
		});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/",
				time: "20200101000000",
			}),
			expect.stringContaining("no snapshot"),
		);
	});

	it("'failed' event listener logs jobId, attemptsMade, data, err.message", async () => {
		const logger = makeLogger();
		startArchiveWorkers(baseOpts({ logger }));
		const worker = findWorker(QUEUE_EXACT);
		const failedHandler = worker.on.mock.calls.find((c) => c[0] === "failed")?.[1] as (
			job: unknown,
			err: Error,
		) => void;
		expect(failedHandler).toBeDefined();
		failedHandler(
			{ id: "failed-1", attemptsMade: 3, data: { url: "https://example.com/", time: "x" } },
			new Error("boom"),
		);
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "failed-1",
				attemptsMade: 3,
				data: expect.any(Object),
				err: "boom",
			}),
			expect.stringContaining("failed"),
		);
	});
});

// --- Crawl processor ---------------------------------------------------------

describe("crawl worker processor", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	function makeCrawlJob(
		id: string,
		data: Record<string, unknown>,
		extendLock = jest.fn().mockResolvedValue(0),
	): {
		id: string;
		data: Record<string, unknown>;
		token: string;
		updateProgress: jest.Mock;
		extendLock: jest.Mock;
	} {
		return {
			id,
			data,
			token: `tk-${id}`,
			updateProgress: jest.fn().mockResolvedValue(undefined),
			extendLock,
		};
	}

	it("queries CDX with url=host/*, the dayWindow from/to, and statuscode:200/collapse=urlkey filters", async () => {
		// Return one row so the apex variant succeeds (no www fallback needed here).
		const cdxFetch = jest.fn(async () =>
			jsonResponse([["original", "timestamp"], ["http://example.com/", "20200101120000"]]),
		);
		startArchiveWorkers(baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-q", { host: "example.com", time: "20200101000000" }));
		// Apex variant returned results so only one CDX call was needed.
		expect(cdxFetch).toHaveBeenCalledTimes(1);
		const calledUrl = String((cdxFetch.mock.calls[0] as unknown[])[0]);
		expect(calledUrl).toContain("url=example.com%2F*");
		expect(calledUrl).toContain("from=20200101000000");
		expect(calledUrl).toContain("to=20200101235959");
		expect(calledUrl).toContain("filter=statuscode%3A200");
		expect(calledUrl).toContain("collapse=urlkey");
		expect(calledUrl).toContain("fl=original%2Ctimestamp");
	});

	it("writes each enumerated URL via cache.writeFile keyed on the JOB time, not the snapshot timestamp", async () => {
		const cache = makeCache();
		const cdxFetch = jest.fn(async () =>
			jsonResponse([
				["original", "timestamp"],
				["http://example.com/", "20200101120000"],
				["http://example.com/about", "20200101130000"],
			]),
		);
		const body = Buffer.from("snap");
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(),
			fetchAtResolvedTime: jest.fn(async () => ({
				outcome: "ok" as const,
				body,
				contentType: "text/html",
			})),
		};
		startArchiveWorkers(
			baseOpts({ cache, cdxFetch: cdxFetch as unknown as typeof fetch, directClient }),
		);
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(
			makeCrawlJob("c-write", { host: "example.com", time: "20200101000000" }),
		);
		expect(directClient.fetchAtResolvedTime).toHaveBeenCalledTimes(2);
		expect(directClient.fetchAtResolvedTime).toHaveBeenCalledWith(
			"http://example.com/",
			"20200101120000",
		);
		expect(directClient.fetchAtResolvedTime).toHaveBeenCalledWith(
			"http://example.com/about",
			"20200101130000",
		);
		expect(cache.writeFile).toHaveBeenCalledWith("http://example.com/", "20200101000000", body);
		expect(cache.writeFile).toHaveBeenCalledWith(
			"http://example.com/about",
			"20200101000000",
			body,
		);
	});

	it("skips CDX rows whose hostname differs from the job host (no cache layout drift)", async () => {
		const cdxFetch = jest.fn(async () =>
			jsonResponse([
				["original", "timestamp"],
				["http://example.com/", "20200101120000"],
				["http://other.com/strange", "20200101130000"],
			]),
		);
		const directClient = defaultDirectClient();
		startArchiveWorkers(baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch, directClient }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-host", { host: "example.com", time: "20200101000000" }));
		expect(directClient.fetchAtResolvedTime).toHaveBeenCalledTimes(1);
		expect(directClient.fetchAtResolvedTime).toHaveBeenCalledWith(
			"http://example.com/",
			"20200101120000",
		);
	});

	it("rejects invalid DomainCrawlJob payloads via the asserter", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL);
		await expect(
			worker.processor({
				id: "bad",
				data: { host: "", time: "20200101000000" },
				token: "tk",
				extendLock: jest.fn(),
			}),
		).rejects.toThrow(/Invalid job/);
	});

	it("schedules a lock-extender that calls job.extendLock every 110s and clears in finally", async () => {
		let resolveCdx: (r: Response) => void = () => undefined;
		const cdxFetch = jest.fn(
			() =>
				new Promise<Response>((res) => {
					resolveCdx = res;
				}),
		);
		const extendLockMock = jest.fn().mockResolvedValue(0);
		startArchiveWorkers(baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch }));
		const worker = findWorker(QUEUE_CRAWL);
		const jobPromise = worker.processor(
			makeCrawlJob("c-lock", { host: "example.com", time: "20200101000000" }, extendLockMock),
		);
		await Promise.resolve();
		await Promise.resolve();
		jest.advanceTimersByTime(109_999);
		expect(extendLockMock).not.toHaveBeenCalled();
		jest.advanceTimersByTime(1);
		expect(extendLockMock).toHaveBeenCalledTimes(1);
		expect(extendLockMock).toHaveBeenCalledWith("tk-c-lock", 120_000);
		jest.advanceTimersByTime(110_000);
		expect(extendLockMock).toHaveBeenCalledTimes(2);
		// Resolve with a row so the apex variant succeeds — no www fallback triggered.
		resolveCdx(jsonResponse([["original", "timestamp"], ["http://example.com/", "20200101000000"]]));
		await jobPromise;
		jest.advanceTimersByTime(500_000);
		expect(extendLockMock).toHaveBeenCalledTimes(2);
	});

	it("clears the lock-extender interval even when enumeration throws", async () => {
		const cdxFetch = jest.fn(async () => new Response("err", { status: 500 }));
		const extendLockMock = jest.fn().mockResolvedValue(0);
		startArchiveWorkers(baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch }));
		const worker = findWorker(QUEUE_CRAWL);
		await expect(
			worker.processor(
				makeCrawlJob("c-err", { host: "example.com", time: "20200101000000" }, extendLockMock),
			),
		).rejects.toThrow(/CDX enumeration 500/);
		jest.advanceTimersByTime(500_000);
		expect(extendLockMock).not.toHaveBeenCalled();
	});

	it("crawl worker does NOT write the not-found sentinel — sentinels are exact-URL-only", async () => {
		const cache = makeCache();
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_CRAWL);
		// All variants return empty → job throws. Sentinels must still not be
		// written: "no CDX captures in window" is not the same as "404 not found".
		await expect(
			worker.processor(makeCrawlJob("c-no-sentinel", { host: "example.com", time: "20200101000000" })),
		).rejects.toThrow(/no captures/);
		expect(cache.writeNotFoundSentinel).not.toHaveBeenCalled();
	});

	it("triggers rateLimit() and re-throws RateLimitError when CDX rows return 429 fallback", async () => {
		const cdxFetch = jest.fn(async () =>
			jsonResponse([
				["original", "timestamp"],
				["http://example.com/", "20200101120000"],
			]),
		);
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(),
			fetchAtResolvedTime: jest.fn(async () => ({
				outcome: "fallback" as const,
				reason: "http-429",
			})),
		};
		startArchiveWorkers(baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch, directClient }));
		const worker = findWorker(QUEUE_CRAWL);
		await expect(
			worker.processor(makeCrawlJob("c-429", { host: "example.com", time: "20200101000000" })),
		).rejects.toThrow("RateLimitError");
		expect(worker.rateLimit).toHaveBeenCalledWith(60_000);
	});

	it("processes CDX rows strictly sequentially (call N+1 waits for call N)", async () => {
		// Use real timers — this test orchestrates microtasks across deferred promises.
		jest.useRealTimers();
		const cdxFetch = jest.fn(async () =>
			jsonResponse([
				["original", "timestamp"],
				["http://example.com/a", "20200101120000"],
				["http://example.com/b", "20200101130000"],
				["http://example.com/c", "20200101140000"],
			]),
		);
		const deferreds: Array<{
			resolve: (v: ResolvedResult) => void;
			promise: Promise<ResolvedResult>;
		}> = [];
		const fetchAtResolvedTime = jest.fn(() => {
			let resolve!: (v: ResolvedResult) => void;
			const promise = new Promise<ResolvedResult>((r) => {
				resolve = r;
			});
			deferreds.push({ resolve, promise });
			return promise;
		});
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(),
			fetchAtResolvedTime,
		};
		startArchiveWorkers(
			baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch, directClient }),
		);
		const worker = findWorker(QUEUE_CRAWL);
		const jobPromise = worker.processor(
			makeCrawlJob("c-seq", { host: "example.com", time: "20200101000000" }),
		);

		// Allow CDX enumeration + first fetch dispatch to flush.
		await new Promise((r) => setImmediate(r));
		expect(fetchAtResolvedTime).toHaveBeenCalledTimes(1);

		deferreds[0].resolve({
			outcome: "ok",
			body: Buffer.from("a"),
			contentType: "text/html",
		});
		await new Promise((r) => setImmediate(r));
		expect(fetchAtResolvedTime).toHaveBeenCalledTimes(2);

		deferreds[1].resolve({
			outcome: "ok",
			body: Buffer.from("b"),
			contentType: "text/html",
		});
		await new Promise((r) => setImmediate(r));
		expect(fetchAtResolvedTime).toHaveBeenCalledTimes(3);

		deferreds[2].resolve({
			outcome: "ok",
			body: Buffer.from("c"),
			contentType: "text/html",
		});
		await jobPromise;
	});

	it("breaks the loop on first 429-style fallback; remaining rows are never fetched", async () => {
		const cdxFetch = jest.fn(async () =>
			jsonResponse([
				["original", "timestamp"],
				["http://example.com/a", "20200101120000"],
				["http://example.com/b", "20200101130000"],
				["http://example.com/c", "20200101140000"],
				["http://example.com/d", "20200101150000"],
				["http://example.com/e", "20200101160000"],
			]),
		);
		let call = 0;
		const fetchAtResolvedTime = jest.fn(async (): Promise<ResolvedResult> => {
			call++;
			if (call === 2) return { outcome: "fallback", reason: "http-429" };
			return { outcome: "ok", body: Buffer.from("x"), contentType: "text/html" };
		});
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(),
			fetchAtResolvedTime,
		};
		startArchiveWorkers(
			baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch, directClient }),
		);
		const worker = findWorker(QUEUE_CRAWL);
		await expect(
			worker.processor(makeCrawlJob("c-break", { host: "example.com", time: "20200101000000" })),
		).rejects.toThrow("RateLimitError");
		// Only rows 1 and 2 fetched — rows 3,4,5 skipped because of the break.
		expect(fetchAtResolvedTime).toHaveBeenCalledTimes(2);
		expect(worker.rateLimit).toHaveBeenCalledWith(60_000);
	});

	it("continues past per-row rejections; cache writes reflect only successful fetches", async () => {
		const cache = makeCache();
		const cdxFetch = jest.fn(async () =>
			jsonResponse([
				["original", "timestamp"],
				["http://example.com/a", "20200101120000"],
				["http://example.com/b", "20200101130000"],
				["http://example.com/c", "20200101140000"],
				["http://example.com/d", "20200101150000"],
			]),
		);
		let call = 0;
		const fetchAtResolvedTime = jest.fn(async (): Promise<ResolvedResult> => {
			call++;
			if (call === 2) throw new Error("transport error");
			return { outcome: "ok", body: Buffer.from("x"), contentType: "text/html" };
		});
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(),
			fetchAtResolvedTime,
		};
		startArchiveWorkers(
			baseOpts({ cache, cdxFetch: cdxFetch as unknown as typeof fetch, directClient }),
		);
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(
			makeCrawlJob("c-fault", { host: "example.com", time: "20200101000000" }),
		);
		// All 4 rows attempted (rejection on row 2 must not abort).
		expect(fetchAtResolvedTime).toHaveBeenCalledTimes(4);
		// 3 successful fetches → 3 cache writes.
		expect(cache.writeFile).toHaveBeenCalledTimes(3);
	});

	it("download_done payload reports filesSeen equal to successful cache writes (not rows.length)", async () => {
		const cache = makeCache();
		const cdxFetch = jest.fn(async () =>
			jsonResponse([
				["original", "timestamp"],
				["http://example.com/a", "20200101120000"],
				["http://example.com/b", "20200101130000"],
				["http://example.com/c", "20200101140000"],
				["http://example.com/d", "20200101150000"],
			]),
		);
		let call = 0;
		const fetchAtResolvedTime = jest.fn(async (): Promise<ResolvedResult> => {
			call++;
			if (call === 2) throw new Error("transport error");
			if (call === 4) return { outcome: "not_found" };
			return { outcome: "ok", body: Buffer.from("x"), contentType: "text/html" };
		});
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(),
			fetchAtResolvedTime,
		};
		startArchiveWorkers(
			baseOpts({ cache, cdxFetch: cdxFetch as unknown as typeof fetch, directClient }),
		);
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeCrawlJob("c-done", { host: "example.com", time: "20200101000000" });
		await worker.processor(job);

		const doneCall = job.updateProgress.mock.calls.find(
			(c) => (c[0] as { stage: string }).stage === "download_done",
		);
		expect(doneCall).toBeDefined();
		// 4 rows; row 2 throws, row 4 not_found, rows 1+3 ok → filesSeen=2 (NOT rows.length=4).
		expect(doneCall![0]).toMatchObject({ stage: "download_done", filesSeen: 2 });
	});

	it("falls back to www variant when apex CDX returns empty (www-only legacy sites)", async () => {
		// Reproduces the ibm.com / apple.com case: job host is www.example.com,
		// CDX has zero captures for apex (example.com) but captures for www.
		const cdxFetch = jest.fn(async (url: string) => {
			const urlParam = new URLSearchParams(new URL(String(url)).search).get("url") ?? "";
			if (urlParam.startsWith("www.")) {
				return jsonResponse([
					["original", "timestamp"],
					["http://www.example.com/", "20010912000000"],
				]);
			}
			return jsonResponse([]); // apex has no captures
		});
		const directClient = defaultDirectClient();
		startArchiveWorkers(baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch, directClient }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(
			makeCrawlJob("c-www", { host: "www.example.com", time: "20010912000000" }),
		);
		expect(directClient.fetchAtResolvedTime).toHaveBeenCalledWith(
			"http://www.example.com/",
			"20010912000000",
		);
	});

	it("tries all host variants and throws 'no captures' if all are empty", async () => {
		const cdxFetch = jest.fn(async () => jsonResponse([]));
		startArchiveWorkers(baseOpts({ cdxFetch: cdxFetch as unknown as typeof fetch }));
		const worker = findWorker(QUEUE_CRAWL);
		await expect(
			worker.processor(makeCrawlJob("c-nocap", { host: "example.com", time: "20200101000000" })),
		).rejects.toThrow(/no captures/);
		// Both apex and www variants must be tried before giving up
		expect(cdxFetch).toHaveBeenCalledTimes(2);
	});

	it("logs a warning (but does not throw) when extendLock rejects", async () => {
		let resolveCdx: (r: Response) => void = () => undefined;
		const cdxFetch = jest.fn(
			() =>
				new Promise<Response>((res) => {
					resolveCdx = res;
				}),
		);
		const extendLockMock = jest.fn().mockRejectedValue(new Error("lock lost"));
		const logger = makeLogger();
		startArchiveWorkers(baseOpts({ logger, cdxFetch: cdxFetch as unknown as typeof fetch }));
		const worker = findWorker(QUEUE_CRAWL);
		const jobPromise = worker.processor(
			makeCrawlJob("c-warn", { host: "example.com", time: "20200101000000" }, extendLockMock),
		);
		await Promise.resolve();
		await Promise.resolve();
		jest.advanceTimersByTime(110_000);
		await Promise.resolve();
		await Promise.resolve();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: "lock lost" }),
			expect.stringContaining("extendLock failed"),
		);
		// Resolve with a row so the apex variant succeeds — no www fallback triggered.
		resolveCdx(jsonResponse([["original", "timestamp"], ["http://example.com/", "20200101000000"]]));
		await jobPromise;
	});
});

// --- attachQueueLogger -------------------------------------------------------

describe("attachQueueLogger", () => {
	function makeEvents(): { on: jest.Mock; handlers: Record<string, (args: unknown) => void> } {
		const handlers: Record<string, (args: unknown) => void> = {};
		const on = jest.fn((event: string, handler: (args: unknown) => void) => {
			handlers[event] = handler;
		});
		return {
			on,
			handlers,
		};
	}

	it("registers handlers for active/completed/failed/stalled", () => {
		const logger = makeLogger();
		const events = makeEvents();
		attachQueueLogger(
			"archive-exact",
			events as unknown as Parameters<typeof attachQueueLogger>[1],
			logger,
		);
		expect(events.on).toHaveBeenCalledWith("active", expect.any(Function));
		expect(events.on).toHaveBeenCalledWith("completed", expect.any(Function));
		expect(events.on).toHaveBeenCalledWith("failed", expect.any(Function));
		expect(events.on).toHaveBeenCalledWith("stalled", expect.any(Function));
	});

	it("computes durationMs from the active→completed time delta", () => {
		const logger = makeLogger();
		const events = makeEvents();
		attachQueueLogger(
			"archive-exact",
			events as unknown as Parameters<typeof attachQueueLogger>[1],
			logger,
		);
		const nowSpy = jest.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(1_000);
		events.handlers.active({ jobId: "j-1" });
		nowSpy.mockReturnValueOnce(1_750);
		events.handlers.completed({ jobId: "j-1" });
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({
				queue: "archive-exact",
				jobId: "j-1",
				durationMs: 750,
				event: "completed",
			}),
			expect.stringContaining("completed"),
		);
		nowSpy.mockRestore();
	});

	it("computes durationMs on failed events and logs failedReason", () => {
		const logger = makeLogger();
		const events = makeEvents();
		attachQueueLogger(
			"archive-exact",
			events as unknown as Parameters<typeof attachQueueLogger>[1],
			logger,
		);
		const nowSpy = jest.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(5_000);
		events.handlers.active({ jobId: "j-2" });
		nowSpy.mockReturnValueOnce(6_200);
		events.handlers.failed({ jobId: "j-2", failedReason: "oops" });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				queue: "archive-exact",
				jobId: "j-2",
				durationMs: 1_200,
				failedReason: "oops",
				event: "failed",
			}),
			expect.stringContaining("failed"),
		);
		nowSpy.mockRestore();
	});

	it("logs stalled events without a duration", () => {
		const logger = makeLogger();
		const events = makeEvents();
		attachQueueLogger(
			"archive-crawl",
			events as unknown as Parameters<typeof attachQueueLogger>[1],
			logger,
		);
		events.handlers.stalled({ jobId: "j-3" });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ queue: "archive-crawl", jobId: "j-3", event: "stalled" }),
			expect.stringContaining("stalled"),
		);
	});
});
