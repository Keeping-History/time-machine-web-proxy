// Tests for src/queue/archive-worker.ts.
//
// The exact worker calls `directClient.fetchAtRequestedTime(url, time)` and
// lets Wayback's `im_` endpoint pick the nearest capture server-side — the
// CDX snapshot-resolver is no longer involved. The crawl worker reads cached
// root HTML, extracts same-domain links via rewriteHtmlUrls, and fans out to
// archive-exact BullMQ jobs — zero CDX calls.
//
// The chunk worker fetches one CDX page per job, deduplicates captures to
// one-per-URL (closest timestamp), and enqueues archive-exact jobs.

// --- Module mocks (hoisted before imports) -----------------------------------

const cachedCdxFetchMock = jest.fn();
jest.mock("../../src/lib/cdx-cache", () => ({
	cachedCdxFetch: (...args: unknown[]) => cachedCdxFetchMock(...args),
}));

jest.mock("node:fs", () => ({
	promises: {
		readFile: jest.fn(),
	},
}));

jest.mock("../../src/lib/url-rewriter", () => ({
	rewriteHtmlUrls: jest.fn(),
	stripWaybackToolbar: jest.fn((html: string) => html),
}));

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

import { promises as fsPromises } from "node:fs";
import type pino from "pino";
import type { RequestedResult, ResolvedResult } from "../../src/clients/wayback-direct-client";
import { rewriteHtmlUrls, stripWaybackToolbar } from "../../src/lib/url-rewriter";
import {
	type ArchiveDirectClient,
	attachQueueLogger,
	startArchiveWorkers,
} from "../../src/queue/archive-worker";
import { QUEUE_CRAWL, QUEUE_CRAWL_CHUNK, QUEUE_EXACT } from "../../src/queue/jobs";

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

function makeCrawlJob(
	id: string,
	data: Record<string, unknown>,
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
		extendLock: jest.fn().mockResolvedValue(0),
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
		directClient: defaultDirectClient() as unknown as ArchiveDirectClient,
		enqueueExactJob: jest.fn().mockResolvedValue(undefined),
		logger: makeLogger(),
		bullmqPrefix: "tm",
		workerConcurrency: 2,
		workerRateLimitPerSec: 1,
		redis: null,
		cdxCacheEnabled: false,
		crawlWindowDays: 30,
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
	cachedCdxFetchMock.mockClear();
});

// --- startArchiveWorkers: returned shape + Worker construction ---------------

describe("startArchiveWorkers", () => {
	it("returns an object with `exact`, `crawl`, and `chunk` Worker instances", () => {
		const result = startArchiveWorkers(baseOpts());
		expect(result.exact).toBeDefined();
		expect(result.crawl).toBeDefined();
		expect(result.chunk).toBeDefined();
	});

	it("constructs three Workers, one per queue, in the correct order", () => {
		startArchiveWorkers(baseOpts());
		expect(WorkerMock).toHaveBeenCalledTimes(3);
		expect(workerInstances.map((w) => w.name)).toEqual([QUEUE_EXACT, QUEUE_CRAWL, QUEUE_CRAWL_CHUNK]);
	});

	it("passes the BullMQ prefix to ALL THREE Workers (critical — default 'bull' breaks dispatch)", () => {
		startArchiveWorkers(baseOpts({ bullmqPrefix: "tm" }));
		expect(findWorker(QUEUE_EXACT).opts.prefix).toBe("tm");
		expect(findWorker(QUEUE_CRAWL).opts.prefix).toBe("tm");
		expect(findWorker(QUEUE_CRAWL_CHUNK).opts.prefix).toBe("tm");
	});

	it("threads a non-default prefix through unchanged", () => {
		startArchiveWorkers(baseOpts({ bullmqPrefix: "custom-ns" }));
		expect(findWorker(QUEUE_EXACT).opts.prefix).toBe("custom-ns");
		expect(findWorker(QUEUE_CRAWL).opts.prefix).toBe("custom-ns");
		expect(findWorker(QUEUE_CRAWL_CHUNK).opts.prefix).toBe("custom-ns");
	});

	it("exact worker uses configured concurrency, crawl worker is concurrency: 1", () => {
		startArchiveWorkers(baseOpts({ workerConcurrency: 4 }));
		expect(findWorker(QUEUE_EXACT).opts.concurrency).toBe(4);
		expect(findWorker(QUEUE_CRAWL).opts.concurrency).toBe(1);
	});

	it("applies the rate limiter to ALL THREE workers with duration: 1000ms", () => {
		startArchiveWorkers(baseOpts({ workerRateLimitPerSec: 1 }));
		expect(findWorker(QUEUE_EXACT).opts.limiter).toEqual({ max: 1, duration: 1000 });
		expect(findWorker(QUEUE_CRAWL).opts.limiter).toEqual({ max: 1, duration: 1000 });
		expect(findWorker(QUEUE_CRAWL_CHUNK).opts.limiter).toEqual({ max: 1, duration: 1000 });
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
		expect(findWorker(QUEUE_CRAWL_CHUNK).on).toHaveBeenCalledWith("failed", expect.any(Function));
	});

	it("opts includes enqueueExactJob callback and does not include cdxFetch", () => {
		const opts = baseOpts();
		expect(typeof opts.enqueueExactJob).toBe("function");
		expect("cdxFetch" in opts).toBe(false);
	});
});

// --- Progress emission -------------------------------------------------------

describe("worker progress emission", () => {
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
		(fsPromises.readFile as jest.Mock).mockReset();
		(rewriteHtmlUrls as jest.Mock).mockReset();
		// Default: stripWaybackToolbar is a pass-through
		(stripWaybackToolbar as jest.Mock).mockImplementation((html: string) => html);
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

	it("'failed' event listener on crawl worker logs jobId, attemptsMade, data, err.message", async () => {
		const logger = makeLogger();
		startArchiveWorkers(baseOpts({ logger }));
		const worker = findWorker(QUEUE_CRAWL);
		const failedHandler = worker.on.mock.calls.find((c) => c[0] === "failed")?.[1] as (
			job: unknown,
			err: Error,
		) => void;
		expect(failedHandler).toBeDefined();
		failedHandler(
			{ id: "crawl-fail-1", attemptsMade: 2, data: { host: "example.com", time: "x" } },
			new Error("crawl boom"),
		);
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "crawl-fail-1",
				attemptsMade: 2,
				err: "crawl boom",
			}),
			expect.stringContaining("failed"),
		);
	});

	// --- MISS path ---

	it("calls cache.lookup for http://{host}/ then https://{host}/ before concluding MISS", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue(null);
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-miss-probe", { host: "example.com", time: "20200101000000" }));
		expect(cache.lookup).toHaveBeenCalledTimes(2);
		expect(cache.lookup).toHaveBeenNthCalledWith(1, "http://example.com/", "20200101000000");
		expect(cache.lookup).toHaveBeenNthCalledWith(2, "https://example.com/", "20200101000000");
	});

	it("MISS: enqueues exact job for http://{host}/ and emits download_done with filesSeen:0", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue(null);
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeCrawlJob("c-miss-enqueue", { host: "example.com", time: "20200101000000" });
		await worker.processor(job);
		expect(enqueueExactJob).toHaveBeenCalledTimes(1);
		expect(enqueueExactJob).toHaveBeenCalledWith("http://example.com/", "20200101000000");
		const doneCall = job.updateProgress.mock.calls.find(
			(c) => (c[0] as { stage: string }).stage === "download_done",
		);
		expect(doneCall?.[0]).toMatchObject({ stage: "download_done", filesSeen: 0 });
	});

	it("MISS: emits picked_up then download_done — no download_start", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue(null);
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeCrawlJob("c-miss-stages", { host: "example.com", time: "20200101000000" });
		await worker.processor(job);
		const stages = job.updateProgress.mock.calls.map((c) => (c[0] as { stage: string }).stage);
		expect(stages).toEqual(["picked_up", "download_done"]);
	});

	it("MISS: does not call directClient", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue(null);
		const directClient = defaultDirectClient();
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, directClient, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-miss-direct", { host: "example.com", time: "20200101000000" }));
		expect(directClient.fetchAtRequestedTime).not.toHaveBeenCalled();
		expect(directClient.fetchAtResolvedTime).not.toHaveBeenCalled();
	});

	// --- HIT path ---

	it("HIT on http://: breaks out of candidate loop, does not probe https://", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/cache/root.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(rewriteHtmlUrls as jest.Mock).mockReturnValue({ html: "", discoveredAssets: [] });
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-hit-http", { host: "example.com", time: "20200101000000" }));
		expect(cache.lookup).toHaveBeenCalledTimes(1);
		expect(cache.lookup).toHaveBeenCalledWith("http://example.com/", "20200101000000");
	});

	it("HIT on https://: uses https:// rootUrl when http:// misses", async () => {
		const cache = makeCache();
		cache.lookup
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ absPath: "/cache/root.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(rewriteHtmlUrls as jest.Mock).mockReturnValue({ html: "", discoveredAssets: [] });
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-hit-https", { host: "example.com", time: "20200101000000" }));
		expect(cache.lookup).toHaveBeenCalledTimes(2);
		// rewriteHtmlUrls receives https:// as the base URL
		expect(rewriteHtmlUrls as jest.Mock).toHaveBeenCalledWith(
			expect.any(String),
			"https://example.com/",
			"20200101000000",
			false,
		);
	});

	it("HIT: reads file at hit.absPath via fs.readFile", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/cache/v2/20200101/example.com/index.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(rewriteHtmlUrls as jest.Mock).mockReturnValue({ html: "", discoveredAssets: [] });
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-readfile", { host: "example.com", time: "20200101000000" }));
		expect(fsPromises.readFile).toHaveBeenCalledWith("/cache/v2/20200101/example.com/index.html");
	});

	it("HIT: calls stripWaybackToolbar then passes result to rewriteHtmlUrls with rootUrl + time + false", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/cache/root.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("raw-html-content"));
		(stripWaybackToolbar as jest.Mock).mockReturnValue("stripped-html");
		(rewriteHtmlUrls as jest.Mock).mockReturnValue({ html: "", discoveredAssets: [] });
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-strip", { host: "example.com", time: "20200101000000" }));
		expect(stripWaybackToolbar).toHaveBeenCalledWith("raw-html-content");
		expect(rewriteHtmlUrls).toHaveBeenCalledWith("stripped-html", "http://example.com/", "20200101000000", false);
	});

	it("HIT: enqueues exact jobs only for same-host links, external domains skipped", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/cache/root.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(rewriteHtmlUrls as jest.Mock).mockReturnValue({
			html: "",
			discoveredAssets: [
				{ url: "http://example.com/page1", embeddedTs: "20200101120000" },
				{ url: "http://example.com/page2", embeddedTs: "20200101130000" },
				{ url: "http://other.com/nope", embeddedTs: "20200101140000" },
				{ url: "https://cdn.example.net/lib.js", embeddedTs: "20200101150000" },
			],
		});
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-filter", { host: "example.com", time: "20200101000000" }));
		expect(enqueueExactJob).toHaveBeenCalledTimes(2);
		expect(enqueueExactJob).toHaveBeenCalledWith("http://example.com/page1", "20200101120000");
		expect(enqueueExactJob).toHaveBeenCalledWith("http://example.com/page2", "20200101130000");
	});

	it("HIT: passes link.embeddedTs to enqueueExactJob — NOT the crawl job time", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/cache/root.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(rewriteHtmlUrls as jest.Mock).mockReturnValue({
			html: "",
			discoveredAssets: [
				{ url: "http://example.com/about", embeddedTs: "19991231235959" },
			],
		});
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		// Crawl job time is different from embeddedTs
		await worker.processor(makeCrawlJob("c-embeddedts", { host: "example.com", time: "20200101000000" }));
		expect(enqueueExactJob).toHaveBeenCalledWith("http://example.com/about", "19991231235959");
		expect(enqueueExactJob).not.toHaveBeenCalledWith(expect.any(String), "20200101000000");
	});

	it("HIT: emits download_file per enqueued job; download_done.filesSeen equals enqueued count", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/cache/root.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(rewriteHtmlUrls as jest.Mock).mockReturnValue({
			html: "",
			discoveredAssets: [
				{ url: "http://example.com/a", embeddedTs: "20200101120000" },
				{ url: "http://example.com/b", embeddedTs: "20200101130000" },
				{ url: "http://example.com/c", embeddedTs: "20200101140000" },
			],
		});
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeCrawlJob("c-progress", { host: "example.com", time: "20200101000000" });
		await worker.processor(job);
		const stages = job.updateProgress.mock.calls.map((c) => (c[0] as { stage: string }).stage);
		expect(stages.filter((s) => s === "download_file")).toHaveLength(3);
		const doneCall = job.updateProgress.mock.calls.find(
			(c) => (c[0] as { stage: string }).stage === "download_done",
		);
		expect(doneCall?.[0]).toMatchObject({ stage: "download_done", filesSeen: 3 });
	});

	it("HIT: no same-host links → emits download_done with filesSeen:0", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/cache/root.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(rewriteHtmlUrls as jest.Mock).mockReturnValue({ html: "", discoveredAssets: [] });
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeCrawlJob("c-empty", { host: "example.com", time: "20200101000000" });
		await worker.processor(job);
		expect(enqueueExactJob).not.toHaveBeenCalled();
		const doneCall = job.updateProgress.mock.calls.find(
			(c) => (c[0] as { stage: string }).stage === "download_done",
		);
		expect(doneCall?.[0]).toMatchObject({ stage: "download_done", filesSeen: 0 });
	});

	it("HIT: does not call directClient", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/cache/root.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(rewriteHtmlUrls as jest.Mock).mockReturnValue({ html: "", discoveredAssets: [] });
		const directClient = defaultDirectClient();
		startArchiveWorkers(baseOpts({ cache, directClient }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-nodirect", { host: "example.com", time: "20200101000000" }));
		expect(directClient.fetchAtRequestedTime).not.toHaveBeenCalled();
		expect(directClient.fetchAtResolvedTime).not.toHaveBeenCalled();
	});

	// --- Lock extender ---

	it("setInterval lock-extender is absent — extendLock never called even after 200s", async () => {
		jest.useFakeTimers();
		const cache = makeCache();
		cache.lookup.mockResolvedValue(null);
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeCrawlJob("c-nolock", { host: "example.com", time: "20200101000000" });
		await worker.processor(job);
		jest.advanceTimersByTime(200_000);
		expect(job.extendLock).not.toHaveBeenCalled();
		jest.useRealTimers();
	});

	// --- Error path ---

	it("emits error stage and re-throws when fs.readFile throws", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/cache/root.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockRejectedValue(new Error("disk error"));
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeCrawlJob("c-fserr", { host: "example.com", time: "20200101000000" });
		await expect(worker.processor(job)).rejects.toThrow(/disk error/);
		const stages = job.updateProgress.mock.calls.map((c) => (c[0] as { stage: string }).stage);
		expect(stages[stages.length - 1]).toBe("error");
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

// --- Chunk worker processor --------------------------------------------------

describe("chunk worker processor", () => {
	const CDX_HEADER = [
		"urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length",
	];
	// Two rows for the same URL — dedup must pick the one closest to the target time.
	// Target: 19980101000000. Diff for 130000 < diff for 150000, so /about → 19980101130000.
	const CDX_DATA_DEDUP = [
		CDX_HEADER,
		["com,apple)/", "19980101120000", "http://apple.com/", "text/html", "200", "SHA1:aaa", "1000"],
		["com,apple)/about", "19980101130000", "http://apple.com/about", "text/html", "200", "SHA1:bbb", "500"],
		["com,apple)/about", "19980101150000", "http://apple.com/about", "text/html", "200", "SHA1:ccc", "500"],
	];

	function makeCdxResponse(data: unknown[][]): { ok: boolean; status: number; json: jest.Mock } {
		return { ok: true, status: 200, json: jest.fn().mockResolvedValue(data) };
	}

	beforeEach(() => {
		cachedCdxFetchMock.mockResolvedValue(makeCdxResponse([CDX_HEADER]));
	});

	it("rejects invalid DomainCrawlChunkJob payloads via the asserter", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		await expect(
			worker.processor({ id: "bad", data: { host: "", time: "19980101000000", page: 0 }, token: "tk" }),
		).rejects.toThrow(/Invalid job/);
	});

	it("calls cachedCdxFetch with URL containing &page=0 and from/to matching windowAround(time, 30)", async () => {
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		await worker.processor({ id: "cc-1", data: { host: "apple.com", time: "19980101000000", page: 0 }, token: "tk" });
		expect(cachedCdxFetchMock).toHaveBeenCalledTimes(1);
		const [url] = cachedCdxFetchMock.mock.calls[0] as [string, ...unknown[]];
		expect(url).toContain("apple.com%2F*");
		expect(url).toContain("from=19971202000000");
		expect(url).toContain("to=19980131235959");
		expect(url).toContain("output=json");
		expect(url).toContain("page=0");
	});

	it("uses the correct page number for page=3", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		await worker.processor({ id: "cc-3", data: { host: "apple.com", time: "19980101000000", page: 3 }, token: "tk" });
		const [url] = cachedCdxFetchMock.mock.calls[0] as [string, ...unknown[]];
		expect(url).toContain("page=3");
	});

	it("applies per-URL dedup: enqueueExactJob called once per unique URL with closest timestamp", async () => {
		cachedCdxFetchMock.mockResolvedValue(makeCdxResponse(CDX_DATA_DEDUP));
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		await worker.processor({ id: "cc-dedup", data: { host: "apple.com", time: "19980101000000", page: 0 }, token: "tk" });
		expect(enqueueExactJob).toHaveBeenCalledTimes(2);
		expect(enqueueExactJob).toHaveBeenCalledWith("http://apple.com/", "19980101120000");
		// /about has two snapshots — closest to 19980101000000 wins
		expect(enqueueExactJob).toHaveBeenCalledWith("http://apple.com/about", "19980101130000");
	});

	it("empty CDX page: enqueueExactJob not called", async () => {
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		await worker.processor({ id: "cc-empty", data: { host: "apple.com", time: "19980101000000", page: 0 }, token: "tk" });
		expect(enqueueExactJob).not.toHaveBeenCalled();
	});

	it("non-ok CDX response throws an error containing the status code", async () => {
		cachedCdxFetchMock.mockResolvedValue({ ok: false, status: 503, json: jest.fn() });
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		await expect(
			worker.processor({ id: "cc-503", data: { host: "apple.com", time: "19980101000000", page: 0 }, token: "tk" }),
		).rejects.toThrow(/503/);
	});

	it("429-class CDX error triggers worker.rateLimit(60000) and re-throws Worker.RateLimitError", async () => {
		cachedCdxFetchMock.mockRejectedValue(new Error("http-429 rate limit exceeded"));
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		await expect(
			worker.processor({ id: "cc-429", data: { host: "apple.com", time: "19980101000000", page: 0 }, token: "tk" }),
		).rejects.toThrow("RateLimitError");
		expect(worker.rateLimit).toHaveBeenCalledWith(60_000);
		expect(rateLimitErrorMock).toHaveBeenCalledTimes(1);
	});

	it("emits picked_up progress at job start", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		const job = makeJob("cc-pu", { host: "apple.com", time: "19980101000000", page: 2 });
		await worker.processor(job);
		expect(job.updateProgress).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "picked_up", queue: QUEUE_CRAWL_CHUNK, page: 2 }),
		);
	});

	it("emits download_done with filesSeen=captures.length on success", async () => {
		cachedCdxFetchMock.mockResolvedValue(makeCdxResponse(CDX_DATA_DEDUP));
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		const job = makeJob("cc-done", { host: "apple.com", time: "19980101000000", page: 0 });
		await worker.processor(job);
		expect(job.updateProgress).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "download_done", queue: QUEUE_CRAWL_CHUNK, filesSeen: 2 }),
		);
	});

	it("emits error progress and rethrows on CDX failure", async () => {
		cachedCdxFetchMock.mockRejectedValue(new Error("CDX exploded"));
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		const job = makeJob("cc-err", { host: "apple.com", time: "19980101000000", page: 0 });
		await expect(worker.processor(job)).rejects.toThrow("CDX exploded");
		expect(job.updateProgress).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "error", queue: QUEUE_CRAWL_CHUNK, error: "CDX exploded" }),
		);
	});

	it("'failed' event listener on chunk worker logs jobId, attemptsMade, data, err.message", async () => {
		const logger = makeLogger();
		startArchiveWorkers(baseOpts({ logger }));
		const worker = findWorker(QUEUE_CRAWL_CHUNK);
		const failedHandler = worker.on.mock.calls.find((c) => c[0] === "failed")?.[1] as (
			job: unknown,
			err: Error,
		) => void;
		expect(failedHandler).toBeDefined();
		failedHandler(
			{ id: "cc-fail-1", attemptsMade: 1, data: { host: "apple.com", time: "x", page: 0 } },
			new Error("chunk boom"),
		);
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: "cc-fail-1", attemptsMade: 1, err: "chunk boom" }),
			expect.stringContaining("failed"),
		);
	});
});
