// Tests for src/services/proxy.ts (TASK-009 rewrite).
//
// ProxyService now depends on:
//   - CacheService.lookup(url, time) → CacheHit | null
//   - ArchiveJobClientPort (enqueueExactAndWait, enqueueDomainCrawl)
//   - optional Redis (for the per-host 24h crawl budget)
//   - global fetch (for CDX preflight)
//
// The pipeline:
//   1. lookup → if MISS, enqueueExactAndWait → re-lookup → 502 if still empty
//   2. read file from disk, apply HTML/CSS rewrites
//   3. on HTML MISS only, fire-and-forget enqueueDomainCrawl
//      gated by (a) whitelist, (b) Redis SET NX EX budget, (c) CDX page count

import { promises as fs } from "node:fs";
import pino from "pino";
import type { ArchiveJobClientPort } from "../../src/clients/archive-job-client";
import type { Config } from "../../src/models/config";
import type { CacheHit, CacheService } from "../../src/services/cache";
import { ProxyService } from "../../src/services/proxy";

jest.mock("node:fs", () => ({
	promises: {
		readFile: jest.fn(),
	},
}));

const TIME = "20200101000000";
const TARGET_HTML_URL = "http://example.com/page";
const TARGET_CSS_URL = "http://example.com/style.css";
const TARGET_IMG_URL = "http://example.com/img.png";

const logger = pino({ level: "silent" });

const baseConfig = {
	proxyBase: "http://localhost:8080",
	proxyPrefix: "",
	whitelistHosts: "*",
	crawlMaxCdxPages: 50,
} as unknown as Config;

const makeCache = (lookupImpl?: jest.Mock): jest.Mocked<CacheService> =>
	({
		lookup: lookupImpl ?? jest.fn().mockResolvedValue(null),
	}) as unknown as jest.Mocked<CacheService>;

const makeClient = (): jest.Mocked<ArchiveJobClientPort> => ({
	enqueueExactAndWait: jest.fn().mockResolvedValue(undefined),
	enqueueDomainCrawl: jest.fn().mockResolvedValue(undefined),
});

const makeRedis = (setReturn: "OK" | null = "OK") =>
	({
		set: jest.fn().mockResolvedValue(setReturn),
	}) as unknown as {
		set: jest.Mock<Promise<"OK" | null>, [string, string, string, number, string]>;
	};

const HTML_BODY =
	'<html><head></head><body><a href="/web/20200101000000/http://example.com/x">x</a></body></html>';
const CSS_BODY = "body{background:url(/web/20200101000000/http://example.com/bg.png)}";
const BIN_BODY = Buffer.from([1, 2, 3]);

const htmlHit: CacheHit = { absPath: "/cache/v2/.../index.html", contentType: "text/html" };
const cssHit: CacheHit = { absPath: "/cache/v2/.../style.css", contentType: "text/css" };
const binHit: CacheHit = { absPath: "/cache/v2/.../img.png", contentType: "image/png" };

const mockedReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
const mockedFetch = jest.fn();

beforeEach(() => {
	jest.clearAllMocks();
	(global as unknown as { fetch: jest.Mock }).fetch = mockedFetch;
});

// --- HIT path ---------------------------------------------------------------

describe("ProxyService.fetch — cache HIT", () => {
	it("returns HTML with rewrites applied and cache=HIT; no job enqueued", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(htmlHit));
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("HIT");
		expect(result.contentType).toBe("text/html");
		expect(client.enqueueExactAndWait).not.toHaveBeenCalled();
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
		// rewriteArchiveLinks turns /web/.../http://... into proxyBase/?url=...
		expect(String(result.body)).toContain("http://localhost:8080/?url=");
	});

	it("returns CSS with rewriteCssUrls applied; no job enqueued", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(cssHit));
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(CSS_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig);

		const result = await svc.fetch(TARGET_CSS_URL, TIME);

		expect(result.cache).toBe("HIT");
		expect(result.contentType).toBe("text/css");
		expect(client.enqueueExactAndWait).not.toHaveBeenCalled();
		expect(String(result.body)).toContain("http://localhost:8080/?url=");
	});

	it("returns binary body as a raw Buffer (no rewrite)", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(binHit));
		const client = makeClient();
		mockedReadFile.mockResolvedValue(BIN_BODY);
		const svc = new ProxyService(cache, client, logger, baseConfig);

		const result = await svc.fetch(TARGET_IMG_URL, TIME);

		expect(result.cache).toBe("HIT");
		expect(result.contentType).toBe("image/png");
		expect(result.body).toBeInstanceOf(Buffer);
		expect((result.body as Buffer).equals(BIN_BODY)).toBe(true);
	});
});

// --- MISS path --------------------------------------------------------------

describe("ProxyService.fetch — cache MISS", () => {
	it("enqueues exact job, re-lookups, returns MISS with HTML rewrites", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		// Non-whitelisted to skip crawl side-effect for this test
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "other.com",
		});

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS");
		expect(client.enqueueExactAndWait).toHaveBeenCalledWith(TARGET_HTML_URL, TIME);
		expect(lookup).toHaveBeenCalledTimes(2);
		expect(String(result.body)).toContain("http://localhost:8080/?url=");
	});

	it("throws Error{status:502} when cache is still empty after job completes", async () => {
		const lookup = jest.fn().mockResolvedValue(null);
		const cache = makeCache(lookup);
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toMatchObject({ status: 502 });
		expect(client.enqueueExactAndWait).toHaveBeenCalledTimes(1);
	});

	it("propagates the job rejection when enqueueExactAndWait rejects", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(null));
		const client = makeClient();
		client.enqueueExactAndWait.mockRejectedValue(new Error("job failed"));
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toThrow("job failed");
	});
});

// --- Domain crawl gating ----------------------------------------------------

describe("ProxyService.fetch — domain crawl fire-and-forget", () => {
	const cdxOk = (count = 10) =>
		Promise.resolve({ ok: true, text: () => Promise.resolve(String(count)) });

	it("fires enqueueDomainCrawl on HTML MISS when whitelist passes + CDX ok + budget free", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		mockedFetch.mockReturnValue(cdxOk(10));
		const redis = makeRedis("OK");
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "example.com" },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_HTML_URL, TIME);
		// fire-and-forget — yield to the microtask queue so the void promise settles
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).toHaveBeenCalledWith("example.com", TIME);
		expect(redis.set).toHaveBeenCalledWith("tm:crawl:budget:example.com", "1", "EX", 86_400, "NX");
	});

	it("does NOT fire crawl on cache HIT", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(htmlHit));
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("does NOT fire crawl on non-HTML MISS (e.g. CSS)", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(cssHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(CSS_BODY));
		mockedFetch.mockReturnValue(cdxOk(10));
		const redis = makeRedis("OK");
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "example.com" },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_CSS_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("skips crawl when host is not whitelisted", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		const redis = makeRedis("OK");
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "other.com" },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
		// Budget should not even be consumed when whitelist short-circuits first
		expect(redis.set).not.toHaveBeenCalled();
		// CDX should not be fetched either
		expect(mockedFetch).not.toHaveBeenCalled();
	});

	it("skips crawl when CDX page count exceeds crawlMaxCdxPages", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		mockedFetch.mockReturnValue(cdxOk(9999));
		const redis = makeRedis("OK");
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "example.com", crawlMaxCdxPages: 50 },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("skips crawl when Redis budget is already consumed (SET NX returns null)", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		mockedFetch.mockReturnValue(cdxOk(10));
		const redis = makeRedis(null);
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "example.com" },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
		// Should NOT have called CDX since budget short-circuits before
		expect(mockedFetch).not.toHaveBeenCalled();
	});

	it("does NOT throw when CDX fetch errors — foreground request still succeeds", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		mockedFetch.mockRejectedValue(new Error("CDX network down"));
		const redis = makeRedis("OK");
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "example.com" },
			redis as unknown as import("ioredis").default,
		);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(result.cache).toBe("MISS");
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("works with no Redis (redis arg defaults to null) — budget check is skipped, CDX still runs", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		mockedFetch.mockReturnValue(cdxOk(5));
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "example.com",
		});

		await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).toHaveBeenCalledWith("example.com", TIME);
	});
});
