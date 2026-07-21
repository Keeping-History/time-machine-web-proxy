/**
 * Dependencies wiring test.
 *
 * Mocks `bullmq`, `ioredis`, and the worker-startup helper so we can assert:
 *   1. `new Dependencies(config).get()` exposes the full DependencyStore shape
 *      with the Redis/BullMQ fields and none of the pre-BullMQ legacy fields.
 *   2. `Dependencies.close()` drains in the documented order:
 *        workers (exact + crawl)  →  queues + events  →  redis.quit()
 *      Reverse ordering would log "Connection is closed" warnings in
 *      production, so the ordering test is load-bearing.
 *
 * We track ordering via `jest.fn().mock.invocationCallOrder` — a monotonically
 * increasing sequence id assigned to every call across all jest mock fns.
 */

const workerExactClose = jest.fn().mockResolvedValue(undefined);
const workerCrawlClose = jest.fn().mockResolvedValue(undefined);

const queueExactClose = jest.fn().mockResolvedValue(undefined);
const queueCrawlClose = jest.fn().mockResolvedValue(undefined);

const queueEventsExactClose = jest.fn().mockResolvedValue(undefined);
const queueEventsCrawlClose = jest.fn().mockResolvedValue(undefined);

const redisQuit = jest.fn().mockResolvedValue(undefined);

const queueCtor = jest.fn();
const queueEventsCtor = jest.fn();

jest.mock("../../src/queue/jobs", () => ({
	QUEUE_EXACT: "archive-exact",
	QUEUE_CRAWL: "archive-crawl",
}));

jest.mock("bullmq", () => ({
	Queue: jest.fn().mockImplementation((name: string, opts: unknown) => {
		queueCtor(name, opts);
		// Disambiguate by queue name (resilient across tests/restarts).
		const close = name === "archive-exact" ? queueExactClose : queueCrawlClose;
		return { close, add: jest.fn().mockResolvedValue({ id: "test" }) };
	}),
	QueueEvents: jest.fn().mockImplementation((name: string, opts: unknown) => {
		queueEventsCtor(name, opts);
		const close = name === "archive-exact" ? queueEventsExactClose : queueEventsCrawlClose;
		return { close, on: jest.fn() };
	}),
	Worker: jest.fn(),
}));

const startArchiveWorkersMock = jest.fn().mockReturnValue({
	exact: { close: workerExactClose },
	crawl: { close: workerCrawlClose },
});

jest.mock("../../src/queue/archive-worker", () => ({
	startArchiveWorkers: startArchiveWorkersMock,
	attachQueueLogger: jest.fn(),
}));

jest.mock("ioredis", () => ({
	__esModule: true,
	default: jest.fn().mockImplementation(() => ({
		quit: redisQuit,
		set: jest.fn().mockResolvedValue("OK"),
	})),
}));

import { Dependencies } from "../../src/lib/dependencies";
import type { Config } from "../../src/models/config";

const baseConfig: Config = {
	port: 0,
	hostname: "127.0.0.1",
	defaultTime: "20000101000000",
	cacheDir: "/tmp/cache",
	cacheEnabled: false,
	allowedOrigins: ["*"],
	whitelistHosts: ["*"],
	proxyBase: "http://localhost:0",
	proxyBaseHostname: "localhost",
	cacheClearToken: "",
	wsKeepaliveMs: 30000,
	redisUrl: "redis://localhost:6379",
	bullmqPrefix: "tm",
	domainCrawlEnabled: true,
	workerConcurrency: 2,
	workerRateLimitPerSec: 1,
	crawlMaxDepth: 3,
	crawlMaxPages: 1000,
	crawlJobPriority: 10,
	outboundProxyUrls: [],
	outboundProxyChooser: "sequential",
	outboundProxyUsername: "",
	outboundProxyPassword: "",
	outboundProxyCooldownMs: 60_000,
	directFetchEnabled: true,
	directFetchMaxConcurrent: 10,
	directFetchTimeoutMs: 30_000,
	directFetchRatePerSec: 20,
	directFetchBurst: 30,
	directFetchPoolConnections: 5,
	directFetchPoolKeepaliveMs: 30_000,
	directFetchPoolMaxConcurrentStreams: 10,
	directFetchHttp2Enabled: true,
	directFetchBlockedBaseMs: 5_000,
	directFetchBlockedMaxMs: 600_000,
	prewarmEnabled: true,
	prewarmMaxAssetsPerPage: 100,
	notFoundTtlDays: 30,
	cdxCacheEnabled: true,
	lockTime: false,
	domainRemap: {},
};

describe("Dependencies (TASK-010)", () => {
	beforeEach(() => {
		workerExactClose.mockClear();
		workerCrawlClose.mockClear();
		queueExactClose.mockClear();
		queueCrawlClose.mockClear();
		queueEventsExactClose.mockClear();
		queueEventsCrawlClose.mockClear();
		redisQuit.mockClear();
		queueCtor.mockClear();
		queueEventsCtor.mockClear();
		startArchiveWorkersMock.mockClear();
	});

	it("exposes the full DependencyStore shape (new Redis/BullMQ fields)", () => {
		const deps = new Dependencies(baseConfig).get();
		expect(deps.logger).toBeDefined();
		expect(deps.shutdown).toBeDefined();
		expect(deps.redis).toBeDefined();
		expect(deps.exactQueue).toBeDefined();
		expect(deps.crawlQueue).toBeDefined();
		expect(deps.exactEvents).toBeDefined();
		expect(deps.crawlEvents).toBeDefined();
		expect(deps.workers).toBeDefined();
		expect(deps.workers.exact).toBeDefined();
		expect(deps.workers.crawl).toBeDefined();
		expect(deps.cache).toBeDefined();
		expect(deps.archiveJobClient).toBeDefined();
		expect(deps.proxy).toBeDefined();
		expect(deps.validator).toBeDefined();
		expect(typeof deps.validator.validateTargetUrl).toBe("function");
		expect(typeof deps.validator.isHostWhitelisted).toBe("function");
	});

	it("constructs Queue and QueueEvents with the configured bullmqPrefix", () => {
		new Dependencies(baseConfig);
		// Two Queues (exact + crawl) + two QueueEvents (exact + crawl)
		expect(queueCtor).toHaveBeenCalledTimes(2);
		expect(queueEventsCtor).toHaveBeenCalledTimes(2);
		// All were given prefix "tm"
		for (const call of queueCtor.mock.calls) {
			expect(call[1]).toEqual(expect.objectContaining({ prefix: "tm" }));
		}
		for (const call of queueEventsCtor.mock.calls) {
			expect(call[1]).toEqual(expect.objectContaining({ prefix: "tm" }));
		}
	});

	it("close() drains workers BEFORE queues+events BEFORE redis.quit()", async () => {
		const dependencies = new Dependencies(baseConfig);
		await dependencies.close();

		// All shutdown calls fired exactly once
		expect(workerExactClose).toHaveBeenCalledTimes(1);
		expect(workerCrawlClose).toHaveBeenCalledTimes(1);
		expect(queueExactClose).toHaveBeenCalledTimes(1);
		expect(queueCrawlClose).toHaveBeenCalledTimes(1);
		expect(queueEventsExactClose).toHaveBeenCalledTimes(1);
		expect(queueEventsCrawlClose).toHaveBeenCalledTimes(1);
		expect(redisQuit).toHaveBeenCalledTimes(1);

		const workerExactOrder = workerExactClose.mock.invocationCallOrder[0] as number;
		const workerCrawlOrder = workerCrawlClose.mock.invocationCallOrder[0] as number;
		const queueExactOrder = queueExactClose.mock.invocationCallOrder[0] as number;
		const queueCrawlOrder = queueCrawlClose.mock.invocationCallOrder[0] as number;
		const eventsExactOrder = queueEventsExactClose.mock.invocationCallOrder[0] as number;
		const eventsCrawlOrder = queueEventsCrawlClose.mock.invocationCallOrder[0] as number;
		const redisOrder = redisQuit.mock.invocationCallOrder[0] as number;

		const lastWorker = Math.max(workerExactOrder, workerCrawlOrder);
		const firstQueueOrEvent = Math.min(
			queueExactOrder,
			queueCrawlOrder,
			eventsExactOrder,
			eventsCrawlOrder,
		);
		const lastQueueOrEvent = Math.max(
			queueExactOrder,
			queueCrawlOrder,
			eventsExactOrder,
			eventsCrawlOrder,
		);

		// Workers drain before queues/events
		expect(lastWorker).toBeLessThan(firstQueueOrEvent);
		// Queues/events close before Redis disconnect
		expect(lastQueueOrEvent).toBeLessThan(redisOrder);
	});

	it("close() is idempotent for the test surface (calls underlying close() exactly once)", async () => {
		// Single full shutdown, then assert no double-close. We don't claim
		// idempotency of the production close() itself (that's a future concern);
		// this just guards against accidental duplicate close() wiring inside
		// the Dependencies implementation.
		const dependencies = new Dependencies(baseConfig);
		await dependencies.close();
		expect(workerExactClose).toHaveBeenCalledTimes(1);
		expect(workerCrawlClose).toHaveBeenCalledTimes(1);
		expect(queueExactClose).toHaveBeenCalledTimes(1);
		expect(redisQuit).toHaveBeenCalledTimes(1);
	});

	it("does not expose pre-BullMQ legacy fields on the store", () => {
		const deps = new Dependencies(baseConfig).get() as unknown as Record<string, unknown>;
		expect(deps.queue).toBeUndefined();
		expect(deps.wayback).toBeUndefined();
	});

	it("passes a cache with sentinel and sidecar writers exposed to startArchiveWorkers", () => {
		new Dependencies(baseConfig);
		const opts = startArchiveWorkersMock.mock.calls[0][0] as {
			cache: {
				writeNotFoundSentinel: unknown;
				writeResolvedTimeSidecar: unknown;
			};
		};
		expect(typeof opts.cache.writeNotFoundSentinel).toBe("function");
		expect(typeof opts.cache.writeResolvedTimeSidecar).toBe("function");
	});
});
