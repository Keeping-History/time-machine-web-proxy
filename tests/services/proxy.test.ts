// Tests for src/services/proxy.ts — three-tier fetch pipeline.
//
// ProxyService depends on:
//   - CacheService.lookup / writeFile / writeNotFoundSentinel / writeResolvedTimeSidecar
//   - ArchiveJobClientPort (enqueueExactAndWait, enqueueDomainCrawl)
//   - optional DirectClient (fetchAtRequestedTime / fetchAtResolvedTime)
//   - optional Redis (for the per-host 24h crawl budget)
//   - global fetch (for CDX preflight)
//
// Fetch pipeline tiers:
//   1. cache.lookup → HIT: return with cacheStatus='HIT'
//   2. MISS + directClient → fetchAtRequestedTime:
//        ok       → writeFile + re-lookup → MISS_DIRECT
//        not_found→ writeNotFoundSentinel + throw 404
//        fallback → fall through to Tier 3
//   3. MISS / fallback → enqueueExactAndWait → re-lookup → MISS_WORKER
//   Prewarm (Tier 1): after HTML response, fire-and-forget fetchAtResolvedTime per discoveredAsset

import { promises as fs } from "node:fs";
import pino from "pino";
import type { ArchiveJobClientPort } from "../../src/clients/archive-job-client";
import type { DirectClient } from "../../src/lib/dependencies";
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
	bullmqPrefix: "tm",
	domainCrawlEnabled: true,
} as unknown as Config;

const makeCache = (lookupImpl?: jest.Mock): jest.Mocked<CacheService> =>
	({
		lookup: lookupImpl ?? jest.fn().mockResolvedValue(null),
		writeFile: jest.fn().mockResolvedValue(undefined),
		writeNotFoundSentinel: jest.fn().mockResolvedValue(undefined),
		writeResolvedTimeSidecar: jest.fn().mockResolvedValue(undefined),
		writeContentTypeSidecar: jest.fn().mockResolvedValue(undefined),
	}) as unknown as jest.Mocked<CacheService>;

const makeClient = (): jest.Mocked<ArchiveJobClientPort> => ({
	enqueueExactAndWait: jest.fn().mockResolvedValue(undefined),
	enqueueExact: jest.fn().mockResolvedValue(undefined),
	enqueueDomainCrawl: jest.fn().mockResolvedValue(undefined),
});

const makeRedis = (setReturn: "OK" | null = "OK") =>
	({
		set: jest.fn().mockResolvedValue(setReturn),
	}) as unknown as {
		set: jest.Mock<Promise<"OK" | null>, [string, string, string, number, string]>;
	};

const makeDirectClient = (): jest.Mocked<DirectClient> => ({
	fetchAtRequestedTime: jest.fn().mockResolvedValue({ outcome: "fallback", reason: "default" }),
	fetchAtResolvedTime: jest.fn().mockResolvedValue({ outcome: "fallback", reason: "default" }),
});

// HTML with an embedded Wayback archive URL — rewriteHtmlUrls will include it in discoveredAssets
const HTML_BODY =
	'<html><head></head><body><img src="/web/20200101000000/http://example.com/img.png"><a href="/web/20200101000000/http://example.com/x">x</a></body></html>';
const CSS_BODY = "body{background:url(/web/20200101000000/http://example.com/bg.png)}";
const BIN_BODY = Buffer.from([1, 2, 3]);

// Simple HTML with no Wayback URLs embedded (no discovered assets for prewarm)
const PLAIN_HTML_BODY =
	'<html><head></head><body><a href="http://example.com/x">x</a></body></html>';

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
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("HIT");
		expect(result.contentType).toBe("text/html");
		expect(client.enqueueExactAndWait).not.toHaveBeenCalled();
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
		// rewriteHtmlUrls emits /web/<ts>/<originalUrl> — the proxy host must
		// NOT appear in rewritten attribute values (output is path-based).
		expect(String(result.body)).toContain("/web/20200101000000/http://example.com/x");
		expect(String(result.body)).not.toMatch(/href="https?:\/\/[^/]/);
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
		expect(String(result.body)).toContain("/web/20200101000000/http://example.com/bg.png");
	});

	it("surfaces hit.archiveTime via result.archiveTime when sidecar exists", async () => {
		const cache = makeCache(
			jest.fn().mockResolvedValue({ ...htmlHit, archiveTime: "20010822231227" }),
		);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);
		expect(result.archiveTime).toBe("20010822231227");
	});

	it("falls back to requested time when hit.archiveTime is undefined (legacy file)", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(htmlHit));
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);
		expect(result.archiveTime).toBe(TIME);
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

// --- MISS path (no directClient — falls directly to Tier 3) -----------------

describe("ProxyService.fetch — cache MISS (no directClient → MISS_WORKER)", () => {
	it("enqueues exact job, re-lookups, returns MISS_WORKER with HTML rewrites", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		// Non-whitelisted to skip crawl side-effect for this test
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "other.com",
		});

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS_WORKER");
		expect(client.enqueueExactAndWait).toHaveBeenCalledWith(TARGET_HTML_URL, TIME);
		expect(lookup).toHaveBeenCalledTimes(2);
		expect(String(result.body)).toContain("/web/20200101000000/http://example.com/x");
		expect(String(result.body)).not.toMatch(/href="https?:\/\/[^/]/);
	});

	it("throws Error{status:502} when cache is still empty after job completes", async () => {
		const lookup = jest.fn().mockResolvedValue(null);
		const cache = makeCache(lookup);
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toMatchObject({ status: 502 });
		expect(client.enqueueExactAndWait).toHaveBeenCalledTimes(1);
	});

	it("propagates {status:404} from cache.lookup after job completes (sentinel-driven)", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(Object.assign(new Error("Not in archive"), { status: 404 }));
		const cache = makeCache(lookup);
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toMatchObject({ status: 404 });
		expect(client.enqueueExactAndWait).toHaveBeenCalledTimes(1);
	});

	it("propagates {status:404} from the FIRST cache.lookup (sentinel already present)", async () => {
		// A previous request established the sentinel; this request short-circuits
		// at the first lookup without ever enqueueing.
		const cache = makeCache(
			jest.fn().mockRejectedValue(Object.assign(new Error("Not in archive"), { status: 404 })),
		);
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toMatchObject({ status: 404 });
		expect(client.enqueueExactAndWait).not.toHaveBeenCalled();
	});

	it("still throws 502 when lookup returns null (no sentinel) after job completes", async () => {
		const lookup = jest.fn().mockResolvedValue(null);
		const cache = makeCache(lookup);
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toMatchObject({ status: 502 });
	});

	it("propagates the job rejection when enqueueExactAndWait rejects", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(null));
		const client = makeClient();
		client.enqueueExactAndWait.mockRejectedValue(new Error("job failed"));
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toThrow("job failed");
	});
});

// --- Tier 2: direct-fetch path (MISS_DIRECT) --------------------------------

describe("ProxyService.fetch — Tier 2 direct fetch", () => {
	it("MISS_DIRECT: directClient ok → writeFile, re-lookup, enqueueExactAndWait NOT called", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null) // initial lookup → MISS
			.mockResolvedValueOnce(htmlHit); // re-lookup after writeFile
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		const directBody = Buffer.from(PLAIN_HTML_BODY);
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "ok",
			body: directBody,
			contentType: "text/html",
			resolvedTime: "20200101010000",
		});
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "other.com" },
			null,
			directClient,
		);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS_DIRECT");
		expect(client.enqueueExactAndWait).not.toHaveBeenCalled();
		expect(cache.writeFile).toHaveBeenCalledWith(TARGET_HTML_URL, TIME, directBody);
		expect(cache.writeResolvedTimeSidecar).toHaveBeenCalledWith(
			TIME,
			TARGET_HTML_URL,
			"20200101010000",
		);
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("MISS_DIRECT: writes content-type sidecar when direct returns a Content-Type", async () => {
		// Regression: without the sidecar, a re-lookup of /r/ci (no extension)
		// would fall back to application/octet-stream and the browser would
		// download instead of render. Verify the proxy persists the upstream
		// type so the next read serves the right Content-Type.
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "ok",
			body: Buffer.from(PLAIN_HTML_BODY),
			contentType: "text/html; charset=utf-8",
			resolvedTime: "20200101010000",
		});
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "other.com" },
			null,
			directClient,
		);

		await svc.fetch("http://www.yahoo.com/r/ci", TIME);

		expect(cache.writeContentTypeSidecar).toHaveBeenCalledWith(
			"http://www.yahoo.com/r/ci",
			TIME,
			"text/html; charset=utf-8",
		);
	});

	it("MISS_DIRECT: ok WITHOUT contentType skips writeContentTypeSidecar", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "ok",
			body: Buffer.from(PLAIN_HTML_BODY),
			// no contentType on the direct result
		});
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "other.com" },
			null,
			directClient,
		);

		await svc.fetch(TARGET_HTML_URL, TIME);

		expect(cache.writeContentTypeSidecar).not.toHaveBeenCalled();
	});

	it("MISS_DIRECT: ok without resolvedTime skips writeResolvedTimeSidecar", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "ok",
			body: Buffer.from(PLAIN_HTML_BODY),
			contentType: "text/html",
			// no resolvedTime
		});
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS_DIRECT");
		expect(cache.writeResolvedTimeSidecar).not.toHaveBeenCalled();
	});

	it("Tier 2 not_found → writeNotFoundSentinel invoked, throws 404, no worker call", async () => {
		const lookup = jest.fn().mockResolvedValueOnce(null);
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({ outcome: "not_found" });
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toMatchObject({ status: 404 });
		expect(cache.writeNotFoundSentinel).toHaveBeenCalledWith(TIME, TARGET_HTML_URL);
		expect(client.enqueueExactAndWait).not.toHaveBeenCalled();
	});

	it("Tier 2 fallback → Tier 3 worker invoked, cacheStatus is MISS_WORKER", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null) // initial lookup
			.mockResolvedValueOnce(htmlHit); // re-lookup after worker
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "fallback",
			reason: "upstream 503",
		});
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "other.com" },
			null,
			directClient,
		);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS_WORKER");
		expect(client.enqueueExactAndWait).toHaveBeenCalledWith(TARGET_HTML_URL, TIME);
		expect(cache.writeFile).not.toHaveBeenCalled();
	});

	it("asset MISS without HTML context: Tier 2 first, Tier 3 on fallback", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(binHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "fallback",
			reason: "upstream 503",
		});
		mockedReadFile.mockResolvedValue(BIN_BODY);
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		const result = await svc.fetch(TARGET_IMG_URL, TIME);

		expect(result.cache).toBe("MISS_WORKER");
		expect(directClient.fetchAtRequestedTime).toHaveBeenCalledWith(TARGET_IMG_URL, TIME);
		expect(client.enqueueExactAndWait).toHaveBeenCalledWith(TARGET_IMG_URL, TIME);
	});
});

// --- Tier 1: prewarm (fire-and-forget) ----------------------------------------

describe("ProxyService.fetch — Tier 1 prewarm (fire-and-forget)", () => {
	it("HTML HIT with directClient triggers prewarm for each discoveredAsset; response returned immediately", async () => {
		// HTML_BODY contains /web/20200101000000/http://example.com/img.png and /web/20200101000000/http://example.com/x
		const cache = makeCache(jest.fn().mockResolvedValue(htmlHit));
		const client = makeClient();
		const directClient = makeDirectClient();
		// Prewarm succeeds
		directClient.fetchAtResolvedTime.mockResolvedValue({
			outcome: "ok",
			body: Buffer.from("fake asset"),
			contentType: "image/png",
		});
		(cache as jest.Mocked<CacheService>).writeFile = jest.fn().mockResolvedValue(undefined);
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		// Response is returned immediately (prewarm is not awaited)
		expect(result.cache).toBe("HIT");
		expect(result.contentType).toBe("text/html");

		// Yield to settle fire-and-forget prewarm promises
		await new Promise((r) => setImmediate(r));

		// Prewarm was called for the discovered assets
		expect(directClient.fetchAtResolvedTime).toHaveBeenCalled();
	});

	it("prewarm fire-and-forget: response returned BEFORE prewarm resolves", async () => {
		// Use a delayed prewarm to confirm it doesn't block the response
		const cache = makeCache(jest.fn().mockResolvedValue(htmlHit));
		const client = makeClient();
		const directClient = makeDirectClient();
		let prewarmResolve!: () => void;
		const prewarmBarrier = new Promise<void>((r) => {
			prewarmResolve = r;
		});
		directClient.fetchAtResolvedTime.mockReturnValue(
			prewarmBarrier.then(() => ({ outcome: "fallback" as const, reason: "test" })),
		);
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		// fetch() should resolve WITHOUT waiting for prewarm
		const resultP = svc.fetch(TARGET_HTML_URL, TIME);
		const result = await resultP;
		// prewarm barrier is still pending at this point
		expect(result.cache).toBe("HIT");

		// Now let it finish
		prewarmResolve();
		await new Promise((r) => setImmediate(r));
	});

	it("prewarm error for one asset does NOT prevent HTML response from being returned", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(htmlHit));
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtResolvedTime.mockRejectedValue(new Error("prewarm network error"));
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		// Should NOT throw even though prewarm errors
		const result = await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(result.cache).toBe("HIT");
		expect(result.contentType).toBe("text/html");
	});

	it("HTML MISS_DIRECT also triggers prewarm for discoveredAssets", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		const directBody = Buffer.from(HTML_BODY);
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "ok",
			body: directBody,
			contentType: "text/html",
			resolvedTime: "20200101010000",
		});
		directClient.fetchAtResolvedTime.mockResolvedValue({
			outcome: "ok",
			body: Buffer.from("asset bytes"),
		});
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "other.com" },
			null,
			directClient,
		);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(result.cache).toBe("MISS_DIRECT");
		// prewarm fired for discovered assets
		expect(directClient.fetchAtResolvedTime).toHaveBeenCalled();
	});
});

// --- X-Cache header mapping -------------------------------------------------
// (tested via time-machine.ts in integration tests; here we verify ProxyResult.cache values)

describe("ProxyResult.cache values", () => {
	it("HIT returns cache='HIT'", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(binHit));
		const client = makeClient();
		mockedReadFile.mockResolvedValue(BIN_BODY);
		const svc = new ProxyService(cache, client, logger, baseConfig);

		const result = await svc.fetch(TARGET_IMG_URL, TIME);
		expect(result.cache).toBe("HIT");
	});

	it("Tier 2 ok returns cache='MISS_DIRECT'", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(binHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "ok",
			body: BIN_BODY,
			contentType: "image/png",
		});
		mockedReadFile.mockResolvedValue(BIN_BODY);
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		const result = await svc.fetch(TARGET_IMG_URL, TIME);
		expect(result.cache).toBe("MISS_DIRECT");
	});

	it("Tier 3 worker returns cache='MISS_WORKER'", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(binHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({ outcome: "fallback", reason: "test" });
		mockedReadFile.mockResolvedValue(BIN_BODY);
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		const result = await svc.fetch(TARGET_IMG_URL, TIME);
		expect(result.cache).toBe("MISS_WORKER");
	});
});

// --- Domain crawl gating ----------------------------------------------------

describe("ProxyService.fetch — domain crawl fire-and-forget", () => {
	const cdxOk = (count = 10) =>
		Promise.resolve({ ok: true, text: () => Promise.resolve(String(count)) });

	it("fires enqueueDomainCrawl on HTML MISS_WORKER when whitelist passes + CDX ok + budget free", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
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
		expect(redis.set).toHaveBeenCalledWith("tm-budget:crawl:example.com", "1", "EX", 86_400, "NX");
	});

	it("does NOT fire crawl on cache HIT", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(htmlHit));
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
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
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
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
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
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
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
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
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
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

		expect(result.cache).toBe("MISS_WORKER");
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("CDX preflight URL widens to the calendar day of the requested time, not the exact second", async () => {
		// Previously `from=time&to=time` (exact second) — CDX virtually never matched,
		// so pages was always 0, the cap check always passed, and crawls were enqueued
		// unconditionally regardless of host size.
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		mockedFetch.mockReturnValue(cdxOk(10));
		const redis = makeRedis("OK");
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "example.com" },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_HTML_URL, "20200101123045");
		await new Promise((r) => setImmediate(r));

		expect(mockedFetch).toHaveBeenCalledTimes(1);
		const calledUrl = new URL(mockedFetch.mock.calls[0][0] as string);
		expect(calledUrl.searchParams.get("from")).toBe("20200101000000");
		expect(calledUrl.searchParams.get("to")).toBe("20200101235959");
		expect(calledUrl.searchParams.get("url")).toBe("example.com/*");
	});

	it("works with no Redis (redis arg defaults to null) — budget check is skipped, CDX still runs", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		mockedFetch.mockReturnValue(cdxOk(5));
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "example.com",
		});

		await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).toHaveBeenCalledWith("example.com", TIME);
	});

	it("skips crawl when CDX page count returns 0 (nothing to crawl)", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		mockedFetch.mockReturnValue(cdxOk(0));
		const redis = makeRedis("OK");
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
	});

	it("skips crawl when CDX body is non-integer (indeterminate page count must not enqueue)", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		mockedFetch.mockReturnValue(
			Promise.resolve({ ok: true, text: () => Promise.resolve("<html>error</html>") }),
		);
		const redis = makeRedis("OK");
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
	});
});

// --- Explicit (admin-triggered) domain crawl --------------------------------

describe("ProxyService.triggerDomainCrawl — explicit admin enqueue", () => {
	const cdxOk = (count = 10) =>
		Promise.resolve({ ok: true, text: () => Promise.resolve(String(count)) });

	it("enqueues a crawl when whitelist passes and CDX page count is within cap", async () => {
		// Happy path. Unlike the fire-and-forget side-effect, this MUST surface
		// the success path to the caller — no swallowed errors.
		const cache = makeCache();
		const client = makeClient();
		mockedFetch.mockReturnValue(cdxOk(10));
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "example.com",
		});

		await expect(svc.triggerDomainCrawl("example.com", TIME)).resolves.toBeUndefined();
		expect(client.enqueueDomainCrawl).toHaveBeenCalledWith("example.com", TIME);
	});

	it("throws {status:503} when DOMAIN_CRAWL_ENABLED is false (kill switch honored)", async () => {
		const cache = makeCache();
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			domainCrawlEnabled: false,
		});

		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toMatchObject({
			status: 503,
		});
		// MUST not touch CDX or the client when the kill switch is off.
		expect(mockedFetch).not.toHaveBeenCalled();
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("throws {status:403} when host is not in WHITELIST_HOSTS", async () => {
		const cache = makeCache();
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "other.com",
		});

		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toMatchObject({
			status: 403,
		});
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("throws {status:413} when CDX page count exceeds crawlMaxCdxPages", async () => {
		// Safety net: an admin asking for an oversize crawl gets a clear 413,
		// not a silent runaway job.
		const cache = makeCache();
		const client = makeClient();
		mockedFetch.mockReturnValue(cdxOk(75));
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "example.com",
			crawlMaxCdxPages: 50,
		});

		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toMatchObject({
			status: 413,
		});
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("surfaces the underlying network cause when CDX preflight throws (no generic 'fetch failed')", async () => {
		// undici masks the real failure in a `TypeError: fetch failed` whose
		// `.cause` is the actual SystemError (ENOTFOUND, ECONNREFUSED, …). The
		// describeFetchError helper unwraps it so the operator sees what
		// actually broke instead of a useless wrapper message.
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND web.archive.org"), {
			code: "ENOTFOUND",
		});
		const wrapped = Object.assign(new TypeError("fetch failed"), { cause });
		mockedFetch.mockRejectedValue(wrapped);
		const cache = makeCache();
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "example.com",
		});

		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toThrow(/ENOTFOUND/);
		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toThrow(
			/CDX preflight network error/,
		);
		// And the cause is preserved on the thrown error for upstream loggers.
		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toMatchObject({
			cause: wrapped,
		});
	});

	it("skipPreflight:true bypasses CDX size check and enqueues without calling fetch", async () => {
		// Escape hatch for when archive.org's CDX endpoint is refusing our IP
		// but the downloader path still works. Admin opts in explicitly via the
		// HTTP query param; we must NOT touch fetch at all here, so the
		// preflight-induced ECONNREFUSED can't bubble up.
		const cache = makeCache();
		const client = makeClient();
		mockedFetch.mockImplementation(() => {
			throw new Error("fetch must not be called when skipPreflight is true");
		});
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "example.com",
		});

		await svc.triggerDomainCrawl("example.com", TIME, { skipPreflight: true });

		expect(mockedFetch).not.toHaveBeenCalled();
		expect(client.enqueueDomainCrawl).toHaveBeenCalledWith("example.com", TIME);
	});

	it("skipPreflight:true still enforces the whitelist (security boundary, not a rate-limit)", async () => {
		// Even with the size-cap bypass, an admin can't crawl arbitrary hosts.
		const cache = makeCache();
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "other.com",
		});

		await expect(
			svc.triggerDomainCrawl("example.com", TIME, { skipPreflight: true }),
		).rejects.toMatchObject({ status: 403 });
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("skipPreflight:true still respects the DOMAIN_CRAWL_ENABLED kill switch", async () => {
		const cache = makeCache();
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			domainCrawlEnabled: false,
		});

		await expect(
			svc.triggerDomainCrawl("example.com", TIME, { skipPreflight: true }),
		).rejects.toMatchObject({ status: 503 });
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("does NOT consult the Redis 24h budget — explicit admin action bypasses throttle", async () => {
		// The fire-and-forget path takes a SET NX EX lock per host; the explicit
		// path must not. Verify by passing a redis whose `set` would refuse the
		// lock — the trigger must still enqueue.
		const cache = makeCache();
		const client = makeClient();
		mockedFetch.mockReturnValue(cdxOk(10));
		const redis = makeRedis(null); // SET NX would fail if consulted
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: "example.com" },
			redis as unknown as import("ioredis").default,
		);

		await svc.triggerDomainCrawl("example.com", TIME);

		expect(client.enqueueDomainCrawl).toHaveBeenCalledWith("example.com", TIME);
		expect(redis.set).not.toHaveBeenCalled();
	});

	it("throws {status:422} when CDX page count is 0 (nothing to crawl in window)", async () => {
		const cache = makeCache();
		const client = makeClient();
		mockedFetch.mockReturnValue(cdxOk(0));
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "example.com",
		});
		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toMatchObject({
			status: 422,
		});
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("throws when CDX page-count body is non-integer (indeterminate — safety cap must not be bypassed)", async () => {
		const cache = makeCache();
		const client = makeClient();
		mockedFetch.mockReturnValue(
			Promise.resolve({ ok: true, text: () => Promise.resolve("<html>error</html>") }),
		);
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: "example.com",
		});
		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toThrow(
			/CDX page count indeterminate/,
		);
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});
});
