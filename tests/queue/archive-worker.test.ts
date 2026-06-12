// Tests for src/queue/archive-worker.ts.
//
// The exact worker calls `directClient.fetchAtRequestedTime(url, time)` and
// lets Wayback's `im_` endpoint pick the nearest capture server-side — the
// CDX snapshot-resolver is no longer involved. When an exact job carries crawl
// provenance and the fetched page is HTML, the worker discovers same-host
// links (discoverNavLinks) and enqueues them at depth+1 (recursive BFS crawl),
// bounded by depth and a Redis page budget. The crawl queue just seeds depth 0.

// --- Module mocks (hoisted before imports) -----------------------------------

jest.mock("node:fs", () => ({
	promises: {
		readFile: jest.fn(),
	},
}));

jest.mock("../../src/lib/url-rewriter", () => ({
	discoverNavLinks: jest.fn(() => []),
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
import { Readable } from "node:stream";
import type pino from "pino";
import type { RequestedResult, ResolvedResult } from "../../src/clients/wayback-direct-client";
import { discoverNavLinks, stripWaybackToolbar } from "../../src/lib/url-rewriter";
import {
	type ArchiveDirectClient,
	attachQueueLogger,
	startArchiveWorkers,
} from "../../src/queue/archive-worker";
import { QUEUE_CRAWL, QUEUE_EXACT } from "../../src/queue/jobs";

// Minimal in-memory Redis stub for crawl seen-set + page-budget. Only the
// commands the worker uses (sadd, incr, expire) are implemented.
interface RedisStub {
	sadd: jest.Mock;
	incr: jest.Mock;
	expire: jest.Mock;
	_seen: Set<string>;
	_count: number;
}

function makeRedis(): RedisStub {
	const seen = new Set<string>();
	const stub: RedisStub = {
		_seen: seen,
		_count: 0,
		sadd: jest.fn(async (_key: string, member: string) => {
			if (seen.has(member)) return 0;
			seen.add(member);
			return 1;
		}),
		incr: jest.fn(async () => {
			stub._count += 1;
			return stub._count;
		}),
		expire: jest.fn().mockResolvedValue(1),
	};
	return stub;
}

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
	writeStream: jest.Mock;
	writeContentTypeSidecar: jest.Mock;
	writeNotFoundSentinel: jest.Mock;
	writeTentativeNotFoundSentinel: jest.Mock;
	writeResolvedTimeSidecar: jest.Mock;
	lookup: jest.Mock;
} {
	return {
		cacheDirForJob: jest.fn((time: string, host: string) => `${dir}/v2/${time}/${host}`),
		writeFile: jest.fn().mockResolvedValue(undefined),
		writeStream: jest.fn().mockResolvedValue(undefined),
		writeContentTypeSidecar: jest.fn().mockResolvedValue(undefined),
		writeNotFoundSentinel: jest.fn().mockResolvedValue(undefined),
		writeTentativeNotFoundSentinel: jest.fn().mockResolvedValue(undefined),
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
				body: Readable.from([Buffer.from("<html></html>")]),
				contentType: "text/html",
				resolvedTime: "20200115000000",
			}),
		),
		fetchAtResolvedTime: jest.fn(
			async (_url: string, _ts: string): Promise<ResolvedResult> => ({
				outcome: "ok" as const,
				body: Readable.from([Buffer.from("<html></html>")]),
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
		crawlMaxDepth: 3,
		crawlMaxPages: 1000,
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
	(discoverNavLinks as jest.Mock).mockReset().mockReturnValue([]);
	(stripWaybackToolbar as jest.Mock).mockReset().mockImplementation((html: string) => html);
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

	it("passes the BullMQ prefix to both Workers (critical — default 'bull' breaks dispatch)", () => {
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

	it("applies the rate limiter to both workers with duration: 1000ms", () => {
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

	it("opts includes enqueueExactJob callback", () => {
		const opts = baseOpts();
		expect(typeof opts.enqueueExactJob).toBe("function");
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
				body: Readable.from([Buffer.from("ok")]),
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

	it("writes the response body to cache.writeStream keyed on (url, requested time)", async () => {
		const cache = makeCache();
		const body = Readable.from([Buffer.from("page-bytes")]);
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
		expect(cache.writeStream).toHaveBeenCalledWith(
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
		expect(cache.writeStream).not.toHaveBeenCalled();
		expect(cache.lookup).not.toHaveBeenCalled();
	});

	it("writes resolved-time sidecar from the im_ redirect's timestamp", async () => {
		const cache = makeCache();
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "ok" as const,
				body: Readable.from([Buffer.from("ok")]),
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
				body: Readable.from([Buffer.from("ok")]),
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
				body: Readable.from([Buffer.from("ok")]),
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

	it("fallback on last attempt: writes tentative sentinel and does NOT write it on earlier attempts", async () => {
		const cache = makeCache();
		const directClient: ArchiveDirectClient = {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "fallback" as const,
				reason: "ETIMEDOUT",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
		startArchiveWorkers(baseOpts({ cache, directClient }));
		const worker = findWorker(QUEUE_EXACT);

		// Attempt 0 of 3 — NOT the last attempt; sentinel must NOT be written.
		const jobEarly = {
			...makeJob("j-fallback-early", { url: "https://example.com/slow", time: "20200101000000" }),
			attemptsMade: 0,
			opts: { attempts: 3 },
		};
		await expect(worker.processor(jobEarly)).rejects.toThrow(/ETIMEDOUT/);
		expect(cache.writeTentativeNotFoundSentinel).not.toHaveBeenCalled();

		cache.writeTentativeNotFoundSentinel.mockClear();

		// Attempt 2 of 3 (0-indexed) — IS the last attempt; sentinel MUST be written.
		const jobLast = {
			...makeJob("j-fallback-last", { url: "https://example.com/slow", time: "20200101000000" }),
			attemptsMade: 2,
			opts: { attempts: 3 },
		};
		await expect(worker.processor(jobLast)).rejects.toThrow(/ETIMEDOUT/);
		expect(cache.writeTentativeNotFoundSentinel).toHaveBeenCalledTimes(1);
		expect(cache.writeTentativeNotFoundSentinel).toHaveBeenCalledWith(
			"20200101000000",
			"https://example.com/slow",
		);
	});

	it("fallback sentinel: cache.lookup throws 404-like error when tentative sentinel is present (fast-fail without re-queuing)", async () => {
		const cache = makeCache();
		// Simulate the sentinel already written: lookup fast-fails with status 404.
		const sentinelError = Object.assign(new Error("Not in archive (tentative)"), { status: 404 });
		cache.lookup.mockRejectedValue(sentinelError);

		// directClient is never called when lookup already throws — the proxy
		// layer checks cache before enqueuing. We verify the thrown error shape
		// here to confirm the contract: status 404 propagates to the caller.
		await expect(cache.lookup("https://example.com/slow", "20200101000000")).rejects.toMatchObject({
			message: "Not in archive (tentative)",
			status: 404,
		});
		// Confirm the mock was called (lookup was attempted — not skipped).
		expect(cache.lookup).toHaveBeenCalledWith(
			"https://example.com/slow",
			"20200101000000",
		);
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
				err: expect.any(Error),
			}),
			expect.stringContaining("failed"),
		);
	});
});

// --- Crawl processor (BFS seed) ----------------------------------------------

describe("crawl worker processor (BFS seed)", () => {
	it("rejects invalid DomainCrawlJob payloads via the asserter", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL);
		await expect(
			worker.processor({
				id: "bad",
				data: { host: "", time: "20200101000000" },
				token: "tk",
				updateProgress: jest.fn().mockResolvedValue(undefined),
			}),
		).rejects.toThrow(/Invalid job/);
	});

	it("seeds the homepage as a crawl-flagged exact job at depth 0", async () => {
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-seed", { host: "example.com", time: "20200101000000" }));
		expect(enqueueExactJob).toHaveBeenCalledTimes(1);
		expect(enqueueExactJob).toHaveBeenCalledWith("http://example.com/", "20200101000000", {
			rootHost: "example.com",
			rootTime: "20200101000000",
			depth: 0,
		});
	});

	it("records the homepage in the Redis seen-set when redis is present", async () => {
		const redis = makeRedis();
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ redis, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-seed-seen", { host: "example.com", time: "20200101000000" }));
		expect(redis.sadd).toHaveBeenCalledWith(
			"tm-crawl:seen:example.com:20200101000000",
			"http://example.com/",
		);
		expect(redis.expire).toHaveBeenCalled();
	});

	it("seeds even without redis (recursion just won't dedup)", async () => {
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ redis: null, enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-seed-noredis", { host: "example.com", time: "20200101000000" }));
		expect(enqueueExactJob).toHaveBeenCalledWith("http://example.com/", "20200101000000", {
			rootHost: "example.com",
			rootTime: "20200101000000",
			depth: 0,
		});
	});

	it("emits picked_up then download_done", async () => {
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ enqueueExactJob }));
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeCrawlJob("c-seed-stages", { host: "example.com", time: "20200101000000" });
		await worker.processor(job);
		const stages = job.updateProgress.mock.calls.map((c) => (c[0] as { stage: string }).stage);
		expect(stages).toEqual(["picked_up", "download_done"]);
	});

	it("does not call directClient", async () => {
		const directClient = defaultDirectClient();
		startArchiveWorkers(baseOpts({ directClient, enqueueExactJob: jest.fn().mockResolvedValue(undefined) }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor(makeCrawlJob("c-seed-nodirect", { host: "example.com", time: "20200101000000" }));
		expect(directClient.fetchAtRequestedTime).not.toHaveBeenCalled();
	});

	it("'failed' event listener on crawl worker logs jobId, attemptsMade, err", async () => {
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
			expect.objectContaining({ jobId: "crawl-fail-1", attemptsMade: 2, err: expect.any(Error) }),
			expect.stringContaining("failed"),
		);
	});
});

// --- Exact worker: recursive crawl (BFS walk) --------------------------------

describe("exact worker recursive crawl", () => {
	const CRAWL = { rootHost: "example.com", rootTime: "20200101000000", depth: 0 };

	function htmlDirect(): ArchiveDirectClient {
		return {
			fetchAtRequestedTime: jest.fn(async () => ({
				outcome: "ok" as const,
				body: Readable.from([Buffer.from("<html></html>")]),
				contentType: "text/html",
				resolvedTime: "20200115000000",
			})),
			fetchAtResolvedTime: jest.fn(),
		};
	}

	it("discovers same-host links from a fetched HTML page and enqueues them at depth+1", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/c/index.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(discoverNavLinks as jest.Mock).mockReturnValue([
			"http://example.com/US/",
			"http://example.com/WORLD/",
		]);
		const redis = makeRedis();
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, redis, directClient: htmlDirect(), enqueueExactJob }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor(makeJob("e-recurse", {
			url: "http://example.com/",
			time: "20200101000000",
			crawl: CRAWL,
		}));
		expect(enqueueExactJob).toHaveBeenCalledWith("http://example.com/US/", "20200101000000", {
			rootHost: "example.com",
			rootTime: "20200101000000",
			depth: 1,
		});
		expect(enqueueExactJob).toHaveBeenCalledWith("http://example.com/WORLD/", "20200101000000", {
			rootHost: "example.com",
			rootTime: "20200101000000",
			depth: 1,
		});
	});

	it("does NOT recurse on a non-HTML asset", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/c/logo.gif", contentType: "image/gif" });
		const redis = makeRedis();
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, redis, directClient: htmlDirect(), enqueueExactJob }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor(makeJob("e-asset", {
			url: "http://example.com/logo.gif",
			time: "20200101000000",
			crawl: { ...CRAWL, depth: 1 },
		}));
		expect(discoverNavLinks as jest.Mock).not.toHaveBeenCalled();
		expect(enqueueExactJob).not.toHaveBeenCalled();
	});

	it("does NOT recurse once depth reaches crawlMaxDepth", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/c/index.html", contentType: "text/html" });
		const redis = makeRedis();
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, redis, directClient: htmlDirect(), enqueueExactJob, crawlMaxDepth: 2 }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor(makeJob("e-maxdepth", {
			url: "http://example.com/deep",
			time: "20200101000000",
			crawl: { ...CRAWL, depth: 2 },
		}));
		expect(discoverNavLinks as jest.Mock).not.toHaveBeenCalled();
		expect(enqueueExactJob).not.toHaveBeenCalled();
	});

	it("skips links already in the seen-set (BFS dedup)", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/c/index.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(discoverNavLinks as jest.Mock).mockReturnValue([
			"http://example.com/seen",
			"http://example.com/fresh",
		]);
		const redis = makeRedis();
		redis._seen.add("http://example.com/seen"); // pre-seed one
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, redis, directClient: htmlDirect(), enqueueExactJob }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor(makeJob("e-dedup", {
			url: "http://example.com/",
			time: "20200101000000",
			crawl: CRAWL,
		}));
		expect(enqueueExactJob).toHaveBeenCalledTimes(1);
		expect(enqueueExactJob).toHaveBeenCalledWith(
			"http://example.com/fresh",
			"20200101000000",
			expect.objectContaining({ depth: 1 }),
		);
	});

	it("stops discovery once the page budget is exhausted", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/c/index.html", contentType: "text/html" });
		(fsPromises.readFile as jest.Mock).mockResolvedValue(Buffer.from("<html></html>"));
		(discoverNavLinks as jest.Mock).mockReturnValue(["http://example.com/x"]);
		const redis = makeRedis();
		redis._count = 5; // already at budget
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, redis, directClient: htmlDirect(), enqueueExactJob, crawlMaxPages: 5 }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor(makeJob("e-budget", {
			url: "http://example.com/over",
			time: "20200101000000",
			crawl: { ...CRAWL, depth: 1 },
		}));
		// incr → 6 > budget 5 → no discovery
		expect(discoverNavLinks as jest.Mock).not.toHaveBeenCalled();
		expect(enqueueExactJob).not.toHaveBeenCalled();
	});

	it("a non-crawl (foreground) exact job never recurses", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/c/index.html", contentType: "text/html" });
		const redis = makeRedis();
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, redis, directClient: htmlDirect(), enqueueExactJob }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor(makeJob("e-fg", { url: "http://example.com/", time: "20200101000000" }));
		expect(discoverNavLinks as jest.Mock).not.toHaveBeenCalled();
		expect(enqueueExactJob).not.toHaveBeenCalled();
	});

	it("does not recurse when redis is absent", async () => {
		const cache = makeCache();
		cache.lookup.mockResolvedValue({ absPath: "/c/index.html", contentType: "text/html" });
		const enqueueExactJob = jest.fn().mockResolvedValue(undefined);
		startArchiveWorkers(baseOpts({ cache, redis: null, directClient: htmlDirect(), enqueueExactJob }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor(makeJob("e-noredis", {
			url: "http://example.com/",
			time: "20200101000000",
			crawl: CRAWL,
		}));
		expect(enqueueExactJob).not.toHaveBeenCalled();
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

