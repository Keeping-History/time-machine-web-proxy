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

const setDebugModeMock = jest.fn();

jest.mock(
	"wayback-machine-downloader",
	() => ({
		__esModule: true,
		WaybackMachineDownloader: WaybackMachineDownloaderMock,
		setDebugMode: setDebugModeMock,
	}),
	{ virtual: true },
);
// We inlined `normalizeBaseUrlInput` into our own shim module (see
// `src/lib/normalize-base-url.ts`) because the upstream `lib/utils.js` is not
// in the package's `exports` field — esbuild and strict ESM resolvers reject
// the subpath. Mock the shim instead.
jest.mock("../../src/lib/normalize-base-url", () => ({
	__esModule: true,
	normalizeBaseUrlInput: normalizeBaseUrlInputMock,
}));

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
import {
	attachQueueLogger,
	startArchiveWorkers,
	startDownloadWatcher,
} from "../../src/queue/archive-worker";
import { QUEUE_CRAWL, QUEUE_EXACT } from "../../src/queue/jobs";

// --- Helpers -----------------------------------------------------------------

function makeLogger(): pino.Logger {
	const stub = {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
		// `child()` mirrors pino's API. The worker uses it to scope downloader
		// output; returning the same stub is enough for these tests because
		// they assert on log content, not on child-binding propagation.
		child: jest.fn(),
	};
	stub.child.mockReturnValue(stub);
	return stub as unknown as pino.Logger;
}

function makeCache(dir = "/cache"): {
	cacheDirForJob: jest.Mock;
	writeNotFoundSentinel: jest.Mock;
	writeTentativeNotFoundSentinel: jest.Mock;
	writeResolvedTimeSidecar: jest.Mock;
	lookup: jest.Mock;
} {
	return {
		cacheDirForJob: jest.fn((time: string, host: string) => `${dir}/v2/${time}/${host}`),
		writeNotFoundSentinel: jest.fn().mockResolvedValue(undefined),
		writeTentativeNotFoundSentinel: jest.fn().mockResolvedValue(undefined),
		writeResolvedTimeSidecar: jest.fn().mockResolvedValue(undefined),
		// Default to a non-null hit so the exact worker's post-download
		// validation passes. Tests that exercise the "downloader produced no
		// usable file" path override this explicitly.
		lookup: jest.fn().mockResolvedValue({
			absPath: `${dir}/v2/anytime/anyhost/index.html`,
			contentType: "text/html",
		}),
	};
}

// Default resolver echoes the requested time so legacy tests that expect
// from_timestamp === to_timestamp === requested still pass without changes.
// Tests that exercise resolution semantics override this explicitly.
function defaultResolver(): jest.Mock {
	return jest.fn((_variants: string[], time: string) => Promise.resolve(time));
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
		resolver: defaultResolver() as unknown as Parameters<typeof startArchiveWorkers>[0]["resolver"],
		logger: makeLogger(),
		bullmqPrefix: "tm",
		workerConcurrency: 2,
		workerRateLimitPerSec: 1,
		downloaderThreadsCount: 3,
		// Default: bidirectional disabled for both — keeps existing test assertions
		// stable. Tests exercising asset-vs-direct policy override these explicitly.
		allowLaterFallbackDirect: false,
		allowLaterFallbackAsset: false,
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

	it("exact processor emits picked_up → availability_start → resolved → download_start → download_done", async () => {
		const resolver = jest.fn().mockResolvedValue("20200115000000");
		startArchiveWorkers(baseOpts({ resolver }));
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e1", { url: "https://example.com/", time: "20200101000000" });
		await worker.processor(job);
		expect(progressStages(job.updateProgress)).toEqual([
			"picked_up",
			"availability_start",
			"resolved",
			"download_start",
			"download_done",
		]);
	});

	it("exact processor emits no_snapshot (not resolved) when resolver returns null", async () => {
		const resolver = jest.fn().mockResolvedValue(null);
		startArchiveWorkers(baseOpts({ resolver }));
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e2", { url: "https://example.com/", time: "20200101000000" });
		await worker.processor(job);
		expect(progressStages(job.updateProgress)).toEqual([
			"picked_up",
			"availability_start",
			"no_snapshot",
		]);
	});

	it("exact processor emits error stage before re-throwing on downloader failure", async () => {
		downloadFilesMock.mockRejectedValueOnce(new Error("boom"));
		const resolver = jest.fn().mockResolvedValue("20200115000000");
		startArchiveWorkers(baseOpts({ resolver }));
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e3", { url: "https://example.com/", time: "20200101000000" });
		await expect(worker.processor(job)).rejects.toThrow("boom");
		const stages = progressStages(job.updateProgress);
		expect(stages).toContain("error");
		// error must be the final stage (after download_start)
		expect(stages[stages.length - 1]).toBe("error");
		// payload carries error message
		const errCall = job.updateProgress.mock.calls.find(
			(c) => (c[0] as { stage: string }).stage === "error",
		);
		expect((errCall?.[0] as { error?: string }).error).toBe("boom");
	});

	it("exact processor's resolved-stage payload carries url, time, resolved, queue, jobId", async () => {
		const resolver = jest.fn().mockResolvedValue("20200115000000");
		startArchiveWorkers(baseOpts({ resolver }));
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e-payload", {
			url: "https://example.com/",
			time: "20200101000000",
		});
		await worker.processor(job);
		const resolvedCall = job.updateProgress.mock.calls.find(
			(c) => (c[0] as { stage: string }).stage === "resolved",
		);
		expect(resolvedCall?.[0]).toMatchObject({
			stage: "resolved",
			queue: QUEUE_EXACT,
			jobId: "e-payload",
			url: "https://example.com/",
			time: "20200101000000",
			resolved: "20200115000000",
		});
	});

	it("crawl processor emits picked_up → download_start → download_done", async () => {
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeJob("c1", { host: "example.com", time: "20200101000000" });
		await worker.processor(job);
		expect(progressStages(job.updateProgress)).toEqual([
			"picked_up",
			"download_start",
			"download_done",
		]);
	});

	it("crawl processor emits error stage before re-throwing", async () => {
		downloadFilesMock.mockRejectedValueOnce(new Error("crawl-bust"));
		startArchiveWorkers(baseOpts());
		const worker = findWorker(QUEUE_CRAWL);
		const job = makeJob("c2", { host: "example.com", time: "20200101000000" });
		await expect(worker.processor(job)).rejects.toThrow("crawl-bust");
		const stages = progressStages(job.updateProgress);
		expect(stages[stages.length - 1]).toBe("error");
	});

	it("worker does NOT fail the job when updateProgress throws (observability never blocks correctness)", async () => {
		const resolver = jest.fn().mockResolvedValue("20200115000000");
		startArchiveWorkers(baseOpts({ resolver }));
		const worker = findWorker(QUEUE_EXACT);
		const job = makeJob("e-update-fails", {
			url: "https://example.com/",
			time: "20200101000000",
		});
		job.updateProgress.mockRejectedValue(new Error("redis down"));
		// Should still resolve successfully — progress writes are best-effort.
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
		handlers.progress({ jobId: "p1", data: { stage: "resolved", jobId: "p1", queue: "archive-exact", ts: 1, resolved: "20200115000000" } });
		expect(logger.debug).toHaveBeenCalledWith(
			expect.objectContaining({
				queue: "archive-exact",
				jobId: "p1",
				event: "progress",
				progress: expect.objectContaining({ stage: "resolved" }),
			}),
			expect.stringContaining("progress"),
		);
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
		// download_external_assets is true on the exact worker so referenced
		// CSS/images are pulled in the same job rather than re-queuing per-asset.
		expect(args.download_external_assets).toBe(true);
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
		const args = WaybackMachineDownloaderMock.mock.calls[0][0];
		expect(args.directory).toBe("/c/v2/20200101000000/www.example.com");
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

	it("calls resolver with base.variants and requestedTime BEFORE constructing downloader", async () => {
		const cache = makeCache();
		const resolver = jest.fn().mockResolvedValue("20200115000000");
		startArchiveWorkers(baseOpts({ cache, resolver }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-r",
			data: { url: "https://example.com/", time: "20200101000000" },
			token: "tk-r",
		});
		expect(resolver).toHaveBeenCalledTimes(1);
		const [variants, requestedTime] = resolver.mock.calls[0];
		expect(Array.isArray(variants)).toBe(true);
		expect(requestedTime).toBe("20200101000000");
		// Downloader receives the RESOLVED time, not the requested time.
		expect(WaybackMachineDownloaderMock).toHaveBeenCalledTimes(1);
		const args = WaybackMachineDownloaderMock.mock.calls[0][0];
		expect(args.from_timestamp).toBe("20200115000000");
		expect(args.to_timestamp).toBe("20200115000000");
	});

	it("passes allowLaterFallbackDirect=true to resolver for a direct/top-level URL", async () => {
		// Direct URL (no asset extension) → worker selects the "direct" flag.
		const resolver = jest.fn().mockResolvedValue("20200115000000");
		startArchiveWorkers(
			baseOpts({ resolver, allowLaterFallbackDirect: true, allowLaterFallbackAsset: false }),
		);
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-direct",
			data: { url: "https://example.com/", time: "20200101000000" },
			token: "tk-d",
		});
		const [, , allowLaterFallback] = resolver.mock.calls[0];
		expect(allowLaterFallback).toBe(true);
	});

	it("passes allowLaterFallbackAsset=true to resolver for an asset URL", async () => {
		// Asset URL (.gif) → worker selects the "asset" flag, regardless of
		// the direct policy. This is the AOL screenname_logo.gif regression
		// fix: the proxy will no longer write a 404 sentinel just because the
		// exact requested timestamp had no statuscode:200 capture.
		const resolver = jest.fn().mockResolvedValue("20010914224112");
		startArchiveWorkers(
			baseOpts({ resolver, allowLaterFallbackDirect: false, allowLaterFallbackAsset: true }),
		);
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-asset",
			data: {
				url: "https://www.aol.com/gr/hp01/screenname_logo.gif",
				time: "20010913100012",
			},
			token: "tk-a",
		});
		const [, , allowLaterFallback] = resolver.mock.calls[0];
		expect(allowLaterFallback).toBe(true);
	});

	it("passes allowLaterFallbackDirect=false to resolver for a direct URL when configured strict", async () => {
		// Asymmetric config: direct strict, asset bidirectional (the default
		// shipped policy). A direct URL must NOT inherit the asset flag.
		const resolver = jest.fn().mockResolvedValue("20200101000000");
		startArchiveWorkers(
			baseOpts({ resolver, allowLaterFallbackDirect: false, allowLaterFallbackAsset: true }),
		);
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-direct-strict",
			data: { url: "https://example.com/about", time: "20200101000000" },
			token: "tk-ds",
		});
		const [, , allowLaterFallback] = resolver.mock.calls[0];
		expect(allowLaterFallback).toBe(false);
	});

	it("writes sentinel and skips downloader when resolver returns null", async () => {
		const cache = makeCache();
		const resolver = jest.fn().mockResolvedValue(null);
		startArchiveWorkers(baseOpts({ cache, resolver }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-null",
			data: { url: "https://example.com/", time: "20200101000000" },
			token: "tk-null",
		});
		expect(cache.writeNotFoundSentinel).toHaveBeenCalledWith(
			"20200101000000",
			"https://example.com/",
		);
		expect(WaybackMachineDownloaderMock).not.toHaveBeenCalled();
		expect(downloadFilesMock).not.toHaveBeenCalled();
	});

	it("writes tentative sentinel and completes (no throw) when resolver throws indeterminate-CDX error", async () => {
		// snapshot-resolver throws this exact prefix when CDX is transport-
		// unreachable across all variants/retries. Worker must catch, write a
		// short-lived tentative sentinel, and complete normally so BullMQ does
		// NOT retry — otherwise foreground requests wait ~47s before 404'ing.
		const cache = makeCache();
		const resolver = jest.fn().mockRejectedValue(
			new Error(
				"[snapshot-resolver] all CDX queries failed (transport/non-OK/parse) — refusing to claim 'no snapshot' on indeterminate state",
			),
		);
		startArchiveWorkers(baseOpts({ cache, resolver }));
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "j-indet",
				data: { url: "https://i.ihost.com/i/c.gif", time: "20010913100802" },
				token: "tk-indet",
			}),
		).resolves.toBeUndefined();
		expect(cache.writeTentativeNotFoundSentinel).toHaveBeenCalledWith(
			"20010913100802",
			"https://i.ihost.com/i/c.gif",
		);
		expect(cache.writeNotFoundSentinel).not.toHaveBeenCalled();
		expect(WaybackMachineDownloaderMock).not.toHaveBeenCalled();
	});

	it("still throws (BullMQ retries) on errors other than the indeterminate-CDX message", async () => {
		// Generic errors must continue to propagate so BullMQ retries cover
		// transient pod-restart / network-blip cases. Only the specific
		// snapshot-resolver throw is treated as a non-retriable signal.
		const cache = makeCache();
		const resolver = jest.fn().mockRejectedValue(new Error("kaboom: redis disconnected"));
		startArchiveWorkers(baseOpts({ cache, resolver }));
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "j-generic",
				data: { url: "https://example.com/", time: "20200101000000" },
				token: "tk-generic",
			}),
		).rejects.toThrow("kaboom: redis disconnected");
		expect(cache.writeTentativeNotFoundSentinel).not.toHaveBeenCalled();
		expect(cache.writeNotFoundSentinel).not.toHaveBeenCalled();
	});

	it("returns success (no throw, no retry) when resolver returns null", async () => {
		const resolver = jest.fn().mockResolvedValue(null);
		startArchiveWorkers(baseOpts({ resolver }));
		const worker = findWorker(QUEUE_EXACT);
		// Should resolve successfully so BullMQ does not retry.
		await expect(
			worker.processor({
				id: "j-null2",
				data: { url: "https://example.com/", time: "20200101000000" },
				token: "tk-null2",
			}),
		).resolves.toBeUndefined();
	});

	it("writes resolved-time sidecar after successful download (exact worker)", async () => {
		const cache = makeCache();
		const resolver = jest.fn().mockResolvedValue("20010822231227");
		startArchiveWorkers(baseOpts({ cache, resolver }));
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

	it("does NOT write resolved-time sidecar when resolver returns null", async () => {
		const cache = makeCache();
		const resolver = jest.fn().mockResolvedValue(null);
		startArchiveWorkers(baseOpts({ cache, resolver }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-nosidecar",
			data: { url: "https://example.com/", time: "20010912000000" },
			token: "tk-ns",
		});
		expect(cache.writeResolvedTimeSidecar).not.toHaveBeenCalled();
	});

	it("throws when downloader produces no usable file for THIS (url, time)", async () => {
		const cache = makeCache();
		// Downloader "succeeds" but no file for the requested URL ends up on disk.
		// Without this validation a host-level "any file present" check would
		// have marked the job complete and the proxy would 502 on re-lookup.
		cache.lookup.mockResolvedValueOnce(null);
		const resolver = jest.fn().mockResolvedValue("20010822231227");
		startArchiveWorkers(baseOpts({ cache, resolver }));
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "j-novalid",
				data: { url: "https://example.com/", time: "20010912000000" },
				token: "tk-nv",
			}),
		).rejects.toThrow(/no usable file/);
	});

	it("does NOT write resolved-time sidecar when downloader throws", async () => {
		const cache = makeCache();
		const resolver = jest.fn().mockResolvedValue("20010822231227");
		downloadFilesMock.mockRejectedValueOnce(new Error("download failed"));
		startArchiveWorkers(baseOpts({ cache, resolver }));
		const worker = findWorker(QUEUE_EXACT);
		await expect(
			worker.processor({
				id: "j-throw",
				data: { url: "https://example.com/", time: "20010912000000" },
				token: "tk-th",
			}),
		).rejects.toThrow("download failed");
		expect(cache.writeResolvedTimeSidecar).not.toHaveBeenCalled();
	});

	it("logs resolved snapshot at info level on successful resolution", async () => {
		const logger = makeLogger();
		const resolver = jest.fn().mockResolvedValue("20200115000000");
		startArchiveWorkers(baseOpts({ logger, resolver }));
		const worker = findWorker(QUEUE_EXACT);
		await worker.processor({
			id: "j-log",
			data: { url: "https://example.com/", time: "20200101000000" },
			token: "tk-log",
		});
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/",
				time: "20200101000000",
				resolved: "20200115000000",
			}),
			expect.stringContaining("resolved"),
		);
	});

	it("logs warning on null resolution (no snapshot)", async () => {
		const logger = makeLogger();
		const resolver = jest.fn().mockResolvedValue(null);
		startArchiveWorkers(baseOpts({ logger, resolver }));
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

	it("constructs WaybackMachineDownloader with exact_url:false, dayWindow timestamps, and base from 'https://<host>'", async () => {
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
		// Crawl uses dayWindow(time): all captures across the calendar day.
		expect(args.from_timestamp).toBe("20200101000000");
		expect(args.to_timestamp).toBe("20200101235959");
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
		// Flush the resolver microtask so setInterval is scheduled before we advance timers.
		await Promise.resolve();
		await Promise.resolve();
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

	it("crawl worker does NOT invoke the snapshot resolver — it crawls the whole day window", async () => {
		const resolver = jest.fn().mockResolvedValue("20200115000000");
		startArchiveWorkers(baseOpts({ resolver }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor({
			id: "c-r",
			data: { host: "example.com", time: "20200101000000" },
			token: "tk-cr",
			extendLock: jest.fn().mockResolvedValue(0),
		});
		// Crawl uses dayWindow(time) directly, not the resolver — the goal
		// is to capture all sibling pages within the day, not snap to one.
		expect(resolver).not.toHaveBeenCalled();
		const args = WaybackMachineDownloaderMock.mock.calls[0][0];
		expect(args.from_timestamp).toBe("20200101000000");
		expect(args.to_timestamp).toBe("20200101235959");
	});

	it("crawl worker does NOT write the not-found sentinel — sentinels are exact-URL-only", async () => {
		const cache = makeCache();
		startArchiveWorkers(baseOpts({ cache }));
		const worker = findWorker(QUEUE_CRAWL);
		await worker.processor({
			id: "c-no-sentinel",
			data: { host: "example.com", time: "20200101000000" },
			token: "tk-cns",
			extendLock: jest.fn().mockResolvedValue(0),
		});
		// Empty crawl results do not imply "404" — they may just mean the day
		// window had no captures of any sibling. Sentinels would poison the
		// negative cache for the host root.
		expect(cache.writeNotFoundSentinel).not.toHaveBeenCalled();
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
		// Flush resolver microtask before advancing timers.
		await Promise.resolve();
		await Promise.resolve();
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

// --- startDownloadWatcher sentinel filter ------------------------------------
//
// `fs.watch` recursive is system-resource dependent (kqueue/inotify) and
// flakes under jest. We test the watcher logic by injecting a fake `watchFn`
// that captures the change callback, then driving filesystem events
// synchronously. The filter under test (.notfound/, .notfound-tentative/
// prefix drop) is exactly the production code — only the event SOURCE is
// faked, not the behavior being asserted.

describe("startDownloadWatcher — sentinel-subpath filter", () => {
	interface FakeWatcher {
		fire: (eventType: "rename" | "change", filename: string) => void;
		close: jest.Mock;
		watchFn: jest.Mock;
		callbackReady: Promise<void>;
	}

	function makeFakeWatchFn(): FakeWatcher {
		let cb: ((eventType: string, filename: string) => void) | null = null;
		let resolveReady: () => void = () => undefined;
		const callbackReady = new Promise<void>((r) => {
			resolveReady = r;
		});
		const close = jest.fn();
		const watchFn = jest.fn(
			(_dir: string, _opts: object, callback: (et: string, fn: string) => void) => {
				cb = callback;
				resolveReady();
				return { close } as unknown as ReturnType<typeof import("node:fs").watch>;
			},
		);
		return {
			fire: (eventType, filename) => {
				if (!cb) throw new Error("watchFn callback not yet registered");
				cb(eventType, filename);
			},
			close,
			watchFn: watchFn as unknown as jest.Mock,
			callbackReady,
		};
	}

	let tmpRoot: string;

	beforeEach(async () => {
		const { promises: fsp } = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "tm-watcher-"));
	});

	afterEach(async () => {
		const { promises: fsp } = await import("node:fs");
		await fsp.rm(tmpRoot, { recursive: true, force: true });
	});

	it("drops 'rename' events for .notfound/<hash> sentinel writes", async () => {
		const onFile = jest.fn();
		const fake = makeFakeWatchFn();
		const logger = makeLogger();
		const stop = startDownloadWatcher(
			tmpRoot,
			onFile,
			logger,
			fake.watchFn as unknown as typeof import("node:fs").watch,
		);

		await fake.callbackReady;
		fake.fire("rename", ".notfound/abc123");
		fake.fire("rename", ".notfound/def456");

		expect(onFile).not.toHaveBeenCalled();

		stop();
	});

	it("drops 'rename' events for .notfound-tentative/<hash> sentinel writes", async () => {
		const onFile = jest.fn();
		const fake = makeFakeWatchFn();
		const logger = makeLogger();
		const stop = startDownloadWatcher(
			tmpRoot,
			onFile,
			logger,
			fake.watchFn as unknown as typeof import("node:fs").watch,
		);

		await fake.callbackReady;
		fake.fire("rename", ".notfound-tentative/abc123");
		fake.fire("rename", ".notfound-tentative/def456");

		expect(onFile).not.toHaveBeenCalled();

		stop();
	});

	it("forwards 'rename' events for legitimate files and increments filesSeen", async () => {
		const onFile = jest.fn();
		const fake = makeFakeWatchFn();
		const logger = makeLogger();
		const stop = startDownloadWatcher(
			tmpRoot,
			onFile,
			logger,
			fake.watchFn as unknown as typeof import("node:fs").watch,
		);

		await fake.callbackReady;
		fake.fire("rename", "pics/sunlogo.gif");
		fake.fire("rename", "css/main.css");

		expect(onFile).toHaveBeenCalledTimes(2);
		expect(onFile).toHaveBeenNthCalledWith(1, "pics/sunlogo.gif", 1);
		expect(onFile).toHaveBeenNthCalledWith(2, "css/main.css", 2);

		stop();
	});

	it("filesSeen counter is NOT incremented by filtered sentinel events", async () => {
		const onFile = jest.fn();
		const fake = makeFakeWatchFn();
		const logger = makeLogger();
		const stop = startDownloadWatcher(
			tmpRoot,
			onFile,
			logger,
			fake.watchFn as unknown as typeof import("node:fs").watch,
		);

		await fake.callbackReady;
		// Interleave sentinel between legitimate files — would be off-by-one
		// (1, 3) instead of (1, 2) if the filter incremented the counter.
		fake.fire("rename", "pics/sunlogo.gif");
		fake.fire("rename", ".notfound/sentinel-hash");
		fake.fire("rename", ".notfound-tentative/sentinel-hash");
		fake.fire("rename", "css/main.css");

		expect(onFile).toHaveBeenCalledTimes(2);
		expect(onFile).toHaveBeenNthCalledWith(1, "pics/sunlogo.gif", 1);
		expect(onFile).toHaveBeenNthCalledWith(2, "css/main.css", 2);

		stop();
	});

	it("ignores 'change' events (only 'rename' indicates new files)", async () => {
		const onFile = jest.fn();
		const fake = makeFakeWatchFn();
		const logger = makeLogger();
		const stop = startDownloadWatcher(
			tmpRoot,
			onFile,
			logger,
			fake.watchFn as unknown as typeof import("node:fs").watch,
		);

		await fake.callbackReady;
		fake.fire("change", "pics/sunlogo.gif");

		expect(onFile).not.toHaveBeenCalled();

		stop();
	});

	it("deduplicates repeated 'rename' events for the same filename", async () => {
		const onFile = jest.fn();
		const fake = makeFakeWatchFn();
		const logger = makeLogger();
		const stop = startDownloadWatcher(
			tmpRoot,
			onFile,
			logger,
			fake.watchFn as unknown as typeof import("node:fs").watch,
		);

		await fake.callbackReady;
		fake.fire("rename", "pics/sunlogo.gif");
		fake.fire("rename", "pics/sunlogo.gif");
		fake.fire("rename", "pics/sunlogo.gif");

		expect(onFile).toHaveBeenCalledTimes(1);
		expect(onFile).toHaveBeenCalledWith("pics/sunlogo.gif", 1);

		stop();
	});

	it("calling the returned stop() closes the watcher", async () => {
		const onFile = jest.fn();
		const fake = makeFakeWatchFn();
		const logger = makeLogger();
		const stop = startDownloadWatcher(
			tmpRoot,
			onFile,
			logger,
			fake.watchFn as unknown as typeof import("node:fs").watch,
		);

		await fake.callbackReady;
		stop();

		expect(fake.close).toHaveBeenCalledTimes(1);
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
		nowSpy.mockReturnValueOnce(1_000); // active
		events.handlers.active({ jobId: "j-1" });
		nowSpy.mockReturnValueOnce(1_750); // completed
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
