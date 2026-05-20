// Tests for src/queue/archive-worker.ts (TASK-007).
//
// `wayback-machine-downloader` is pure ESM and cannot be `require()`-d under
// ts-jest's CommonJS harness. We jest.mock both the package and its
// /lib/utils.js subpath with `__esModule: true` markers so the worker module
// loads without touching the real runtime. The same pattern is used for
// `bullmq` so the Worker constructor calls can be captured and verified.

// --- Module mocks ------------------------------------------------------------

const downloadFilesMock = jest.fn().mockResolvedValue(undefined);
const WaybackMachineDownloaderMock = jest
	.fn()
	.mockImplementation(() => ({ download_files: downloadFilesMock }));
const normalizeBaseUrlInputMock = jest.fn((url: string) => {
	const host = new URL(url).hostname.replace(/^www\./, "");
	return {
		canonicalUrl: `https://${host}/`,
		variants: [`https://${host}/`],
		bareHost: host,
		unicodeHost: host,
	};
});

jest.mock(
	"wayback-machine-downloader",
	() => ({
		__esModule: true,
		WaybackMachineDownloader: WaybackMachineDownloaderMock,
	}),
	{ virtual: true },
);
// `lib/utils.js` is not in the package's `exports` field, so jest's resolver
// cannot find it. `virtual: true` lets us mock the path without resolution.
jest.mock(
	"wayback-machine-downloader/lib/utils.js",
	() => ({
		__esModule: true,
		normalizeBaseUrlInput: normalizeBaseUrlInputMock,
	}),
	{ virtual: true },
);

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
// `Worker.RateLimitError` is a static factory method on the BullMQ Worker class.
(WorkerMock as unknown as { RateLimitError: jest.Mock }).RateLimitError = rateLimitErrorMock;

jest.mock("bullmq", () => ({
	__esModule: true,
	Worker: WorkerMock,
	QueueEvents: jest.fn(),
}));

// --- Imports (after mocks) ---------------------------------------------------

import type pino from "pino";
import { attachQueueLogger, startArchiveWorkers } from "../../src/queue/archive-worker";
import { QUEUE_CRAWL, QUEUE_EXACT } from "../../src/queue/jobs";

// --- Helpers -----------------------------------------------------------------

function makeLogger(): pino.Logger {
	return {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	} as unknown as pino.Logger;
}

function makeCache(dir = "/cache"): { cacheDirForJob: jest.Mock } {
	return {
		cacheDirForJob: jest.fn((time: string, host: string) => `${dir}/v2/${time}/${host}`),
	};
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
		logger: makeLogger(),
		bullmqPrefix: "tm",
		workerConcurrency: 2,
		workerRateLimitPerSec: 1,
		downloaderThreadsCount: 3,
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
	WaybackMachineDownloaderMock.mockClear();
	downloadFilesMock.mockReset().mockResolvedValue(undefined);
	normalizeBaseUrlInputMock.mockClear();
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

// --- Exact processor ---------------------------------------------------------

describe("exact worker processor", () => {
	it("constructs WaybackMachineDownloader with exact_url:true and matching from/to timestamps", async () => {
		const cache = makeCache();
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j1",
			data: { url: "https://example.com/", time: "20200101000000" },
			token: "tk-1",
		});
		expect(WaybackMachineDownloaderMock).toHaveBeenCalledTimes(1);
		const args = WaybackMachineDownloaderMock.mock.calls[0][0];
		expect(args.exact_url).toBe(true);
		expect(args.from_timestamp).toBe("20200101000000");
		expect(args.to_timestamp).toBe("20200101000000");
		expect(args.threads_count).toBe(3);
		expect(args.rewrite_mode).toBe("as-is");
		expect(args.canonical_action).toBe("keep");
		expect(args.download_external_assets).toBe(false);
	});

	it("derives directory from cache.cacheDirForJob(time, base.bareHost)", async () => {
		const cache = makeCache("/c");
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j2",
			data: { url: "https://www.example.com/about", time: "20200101000000" },
			token: "tk-2",
		});
		// bareHost strips the leading "www."
		expect(cache.cacheDirForJob).toHaveBeenCalledWith("20200101000000", "example.com");
		const args = WaybackMachineDownloaderMock.mock.calls[0][0];
		expect(args.directory).toBe("/c/v2/20200101000000/example.com");
	});

	it("invokes download_files exactly once", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j3",
			data: { url: "https://example.com/", time: "20200101000000" },
			token: "tk-3",
		});
		expect(downloadFilesMock).toHaveBeenCalledTimes(1);
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

	it("calls worker.rateLimit(60000) and throws Worker.RateLimitError() on a 429 error", async () => {
		downloadFilesMock.mockRejectedValueOnce(new Error("HTTP 429 too many requests"));
		startArchiveWorkers(baseOpts());
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

	it("re-throws non-rate-limit errors so BullMQ exponential backoff retries", async () => {
		downloadFilesMock.mockRejectedValueOnce(new Error("network blip"));
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "j-err",
				data: { url: "https://example.com/", time: "20200101000000" },
				token: "tk-err",
			}),
		).rejects.toThrow("network blip");
		expect(worker.rateLimit).not.toHaveBeenCalled();
		expect(rateLimitErrorMock).not.toHaveBeenCalled();
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

	it("constructs WaybackMachineDownloader with exact_url:false and derives base from 'https://<host>'", async () => {
		const cache = makeCache();
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_CRAWL);
		const jobPromise = worker.processor({
			id: "c1",
			data: { host: "example.com", time: "20200101000000" },
			token: "tk-c1",
			extendLock: jest.fn().mockResolvedValue(0),
		});
		await jobPromise;
		expect(normalizeBaseUrlInputMock).toHaveBeenCalledWith("https://example.com");
		const args = WaybackMachineDownloaderMock.mock.calls[0][0];
		expect(args.exact_url).toBe(false);
		expect(args.from_timestamp).toBe("20200101000000");
		expect(args.to_timestamp).toBe("20200101000000");
		expect(args.directory).toBe("/cache/v2/20200101000000/example.com");
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
		// Use a deferred resolution so we can advance timers while download_files is pending.
		let resolveDownload: () => void = () => undefined;
		downloadFilesMock.mockImplementationOnce(
			() =>
				new Promise<void>((res) => {
					resolveDownload = res;
				}),
		);
		const extendLockMock = jest.fn().mockResolvedValue(0);
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL);
		const jobPromise = worker.processor({
			id: "c-lock",
			data: { host: "example.com", time: "20200101000000" },
			token: "tk-lock",
			extendLock: extendLockMock,
		});
		// Advance to just before the first interval fire to confirm 110s cadence.
		jest.advanceTimersByTime(109_999);
		expect(extendLockMock).not.toHaveBeenCalled();
		jest.advanceTimersByTime(1);
		expect(extendLockMock).toHaveBeenCalledTimes(1);
		expect(extendLockMock).toHaveBeenCalledWith("tk-lock", 120_000);
		// Second fire after another 110s.
		jest.advanceTimersByTime(110_000);
		expect(extendLockMock).toHaveBeenCalledTimes(2);
		// Resolve download and confirm the interval is cleared (no extra fires).
		resolveDownload();
		await jobPromise;
		jest.advanceTimersByTime(500_000);
		expect(extendLockMock).toHaveBeenCalledTimes(2);
	});

	it("clears the lock-extender interval even when download_files throws", async () => {
		downloadFilesMock.mockRejectedValueOnce(new Error("crawl failure"));
		const extendLockMock = jest.fn().mockResolvedValue(0);
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL);
		await expect(
			worker.processor({
				id: "c-err",
				data: { host: "example.com", time: "20200101000000" },
				token: "tk-err",
				extendLock: extendLockMock,
			}),
		).rejects.toThrow("crawl failure");
		jest.advanceTimersByTime(500_000);
		expect(extendLockMock).not.toHaveBeenCalled();
	});

	it("logs a warning (but does not throw) when extendLock rejects", async () => {
		let resolveDownload: () => void = () => undefined;
		downloadFilesMock.mockImplementationOnce(
			() =>
				new Promise<void>((res) => {
					resolveDownload = res;
				}),
		);
		const extendLockMock = jest.fn().mockRejectedValue(new Error("lock lost"));
		const logger = makeLogger();
		startArchiveWorkers(baseOpts({ logger }));
		const worker = findWorker(QUEUE_CRAWL);
		const jobPromise = worker.processor({
			id: "c-warn",
			data: { host: "example.com", time: "20200101000000" },
			token: "tk-warn",
			extendLock: extendLockMock,
		});
		jest.advanceTimersByTime(110_000);
		// Let the rejection microtask flush.
		await Promise.resolve();
		await Promise.resolve();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: "lock lost" }),
			expect.stringContaining("extendLock failed"),
		);
		resolveDownload();
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
			"archive:exact",
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
			"archive:exact",
			events as unknown as Parameters<typeof attachQueueLogger>[1],
			logger,
		);
		const nowSpy = jest.spyOn(Date, "now");
		nowSpy.mockReturnValueOnce(1_000); // active
		events.handlers.active({ jobId: "j-1" });
		nowSpy.mockReturnValueOnce(1_750); // completed
		events.handlers.completed({ jobId: "j-1" });
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({
				queue: "archive:exact",
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
			"archive:exact",
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
				queue: "archive:exact",
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
			"archive:crawl",
			events as unknown as Parameters<typeof attachQueueLogger>[1],
			logger,
		);
		events.handlers.stalled({ jobId: "j-3" });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ queue: "archive:crawl", jobId: "j-3", event: "stalled" }),
			expect.stringContaining("stalled"),
		);
	});
});
