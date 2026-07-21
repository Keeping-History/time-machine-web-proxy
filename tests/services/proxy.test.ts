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
import { Readable } from "node:stream";
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
	whitelistHosts: ["*"],
	bullmqPrefix: "tm",
	domainCrawlEnabled: true,
	prewarmEnabled: true,
	prewarmMaxAssetsPerPage: 100,
} as unknown as Config;

const makeCache = (lookupImpl?: jest.Mock): jest.Mocked<CacheService> =>
	({
		lookup: lookupImpl ?? jest.fn().mockResolvedValue(null),
		writeFile: jest.fn().mockResolvedValue(undefined),
		writeStream: jest.fn().mockResolvedValue(undefined),
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
		// rewriteHtmlUrls emits absolute proxy URLs so embedded cross-origin pages
		// resolve assets against timemachine's origin, not the embedding host.
		expect(String(result.body)).toContain("http://localhost:8080/web/20200101000000/http://example.com/x");
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
		expect(String(result.body)).toContain("http://localhost:8080/web/20200101000000/http://example.com/bg.png");
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

	it("returns binary hit as bodyPath without loading file into memory", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(binHit));
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, baseConfig);

		const result = await svc.fetch(TARGET_IMG_URL, TIME);

		expect(result.cache).toBe("HIT");
		expect(result.contentType).toBe("image/png");
		expect(result.bodyPath).toBe(binHit.absPath);
		expect(result.body).toBeUndefined();
		expect(mockedReadFile).not.toHaveBeenCalled();
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
			whitelistHosts: ["other.com"],
		});

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS_WORKER");
		expect(client.enqueueExactAndWait).toHaveBeenCalledWith(TARGET_HTML_URL, TIME);
		expect(lookup).toHaveBeenCalledTimes(2);
		expect(String(result.body)).toContain("http://localhost:8080/web/20200101000000/http://example.com/x");
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
		const directBody = Readable.from([Buffer.from(PLAIN_HTML_BODY)]);
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
			{ ...baseConfig, whitelistHosts: ["other.com"] },
			null,
			directClient,
		);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS_DIRECT");
		expect(client.enqueueExactAndWait).not.toHaveBeenCalled();
		expect(cache.writeStream).toHaveBeenCalledWith(TARGET_HTML_URL, TIME, directBody);
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
			body: Readable.from([Buffer.from(PLAIN_HTML_BODY)]),
			contentType: "text/html; charset=utf-8",
			resolvedTime: "20200101010000",
		});
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: ["other.com"] },
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
			body: Readable.from([Buffer.from(PLAIN_HTML_BODY)]),
			// no contentType on the direct result
		});
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: ["other.com"] },
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
			body: Readable.from([Buffer.from(PLAIN_HTML_BODY)]),
			contentType: "text/html",
			// no resolvedTime
		});
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS_DIRECT");
		expect(cache.writeResolvedTimeSidecar).not.toHaveBeenCalled();
	});

	it("MISS_DIRECT: a sidecar write failure does NOT fail the asset response (best-effort)", async () => {
		// Regression: the body is already cached via writeStream, so a sidecar
		// metadata write that rejects (e.g. a transient rename race on the shared
		// GCS mount) must not propagate and 502 the asset.
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		cache.writeResolvedTimeSidecar.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		cache.writeContentTypeSidecar.mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "ok",
			body: Readable.from([Buffer.from(PLAIN_HTML_BODY)]),
			contentType: "text/html",
			resolvedTime: "20200101010000",
		});
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: ["other.com"] },
			null,
			directClient,
		);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS_DIRECT");
		expect(cache.writeStream).toHaveBeenCalled();
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
			{ ...baseConfig, whitelistHosts: ["other.com"] },
			null,
			directClient,
		);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(result.cache).toBe("MISS_WORKER");
		expect(client.enqueueExactAndWait).toHaveBeenCalledWith(TARGET_HTML_URL, TIME);
		expect(cache.writeStream).not.toHaveBeenCalled();
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

// --- CDN fallback (404 retry with embedded origin URL) -----------------------

const AKAMAI_URL =
	"http://a284.g.akamai.net/7/284/3299/6d43dd55efa485/www.usrobotics.com/products/images-prod/p-global-xja.gif";
const AKAMAI_FALLBACK_URL =
	"http://www.usrobotics.com/products/images-prod/p-global-xja.gif";

describe("ProxyService.fetch — CDN fallback on 404", () => {
	it("retries with embedded origin URL when CDN URL returns 404 and fallback hits cache", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockRejectedValueOnce(Object.assign(new Error("Not in archive"), { status: 404 })) // CDN URL → 404
			.mockResolvedValueOnce(binHit); // fallback URL → HIT
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(BIN_BODY);
		const svc = new ProxyService(cache, client, logger, baseConfig);

		const result = await svc.fetch(AKAMAI_URL, TIME);

		expect(result.cache).toBe("HIT");
		expect(lookup).toHaveBeenNthCalledWith(1, AKAMAI_URL, TIME);
		expect(lookup).toHaveBeenNthCalledWith(2, AKAMAI_FALLBACK_URL, TIME);
	});

	it("propagates 404 when CDN URL 404s and fallback also 404s", async () => {
		const lookup = jest
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error("Not in archive"), { status: 404 })) // CDN → 404
			.mockRejectedValueOnce(Object.assign(new Error("Not in archive"), { status: 404 })); // fallback → 404
		const cache = makeCache(lookup);
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(AKAMAI_URL, TIME)).rejects.toMatchObject({ status: 404 });
	});

	it("does not retry on 404 when URL is not a CDN URL", async () => {
		const cache = makeCache(
			jest.fn().mockRejectedValue(Object.assign(new Error("Not in archive"), { status: 404 })),
		);
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toMatchObject({ status: 404 });
		// lookup called once for the original URL only — no fallback attempt
		expect(cache.lookup).toHaveBeenCalledTimes(1);
	});

	it("does not retry on non-404 errors from CDN URL", async () => {
		const cache = makeCache(jest.fn().mockRejectedValue(new Error("network failure")));
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, baseConfig);

		await expect(svc.fetch(AKAMAI_URL, TIME)).rejects.toThrow("network failure");
		expect(cache.lookup).toHaveBeenCalledTimes(1);
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
			body: Readable.from([Buffer.from("fake asset")]),
			contentType: "image/png",
		});
		(cache as jest.Mocked<CacheService>).writeStream = jest.fn().mockResolvedValue(undefined);
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
		const directBody = Readable.from([Buffer.from(HTML_BODY)]);
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "ok",
			body: directBody,
			contentType: "text/html",
			resolvedTime: "20200101010000",
		});
		directClient.fetchAtResolvedTime.mockResolvedValue({
			outcome: "ok",
			body: Readable.from([Buffer.from("asset bytes")]),
		});
		mockedReadFile.mockResolvedValue(Buffer.from(HTML_BODY));
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: ["other.com"] },
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

	it("Tier 2 ok returns cache='MISS_DIRECT' for binary and sets bodyPath without readFile", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(binHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValue({
			outcome: "ok",
			body: Readable.from([BIN_BODY]),
			contentType: "image/png",
		});
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient);

		const result = await svc.fetch(TARGET_IMG_URL, TIME);
		expect(result.cache).toBe("MISS_DIRECT");
		expect(result.bodyPath).toBe(binHit.absPath);
		expect(result.body).toBeUndefined();
		expect(mockedReadFile).not.toHaveBeenCalled();
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

// --- Domain crawl gating (recursive BFS seed) -------------------------------

describe("ProxyService.fetch — domain crawl fire-and-forget", () => {
	it("fires enqueueDomainCrawl on HTML MISS_WORKER when whitelist passes + budget free", async () => {
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
			{ ...baseConfig, whitelistHosts: ["example.com"] },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_HTML_URL, TIME);
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
		const redis = makeRedis("OK");
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: ["example.com"] },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_CSS_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("skips crawl when host is not whitelisted (budget not consumed)", async () => {
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
			{ ...baseConfig, whitelistHosts: ["other.com"] },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
		expect(redis.set).not.toHaveBeenCalled();
	});

	it("skips crawl when Redis budget is already consumed (SET NX returns null)", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const redis = makeRedis(null);
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: ["example.com"] },
			redis as unknown as import("ioredis").default,
		);

		await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("works with no Redis (budget check skipped) — still enqueues the crawl seed", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: ["example.com"],
		});

		await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(client.enqueueDomainCrawl).toHaveBeenCalledWith("example.com", TIME);
	});

	it("does NOT throw when enqueueDomainCrawl rejects — foreground request still succeeds", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		client.enqueueDomainCrawl.mockRejectedValue(new Error("redis down"));
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const redis = makeRedis("OK");
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: ["example.com"] },
			redis as unknown as import("ioredis").default,
		);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);
		await new Promise((r) => setImmediate(r));

		expect(result.cache).toBe("MISS_WORKER");
	});
});

describe("ProxyService.triggerDomainCrawl — explicit admin enqueue", () => {
	const TIME = "20010912000000";

	it("enqueues the domain crawl seed when whitelist passes", async () => {
		const cache = makeCache();
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: ["example.com"],
		});
		await expect(svc.triggerDomainCrawl("example.com", TIME)).resolves.toBeUndefined();
		expect(client.enqueueDomainCrawl).toHaveBeenCalledWith("example.com", TIME);
	});

	it("bypasses the per-host budget (does not touch Redis)", async () => {
		const cache = makeCache();
		const client = makeClient();
		const redis = makeRedis("OK");
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, whitelistHosts: ["example.com"] },
			redis as unknown as import("ioredis").default,
		);
		await svc.triggerDomainCrawl("example.com", TIME);
		expect(client.enqueueDomainCrawl).toHaveBeenCalledWith("example.com", TIME);
		expect(redis.set).not.toHaveBeenCalled();
	});

	it("throws 503 when domain crawl is disabled (and does not enqueue)", async () => {
		const cache = makeCache();
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			domainCrawlEnabled: false,
		});
		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toMatchObject({
			status: 503,
		});
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});

	it("throws 403 when host is not whitelisted (and does not enqueue)", async () => {
		const cache = makeCache();
		const client = makeClient();
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: ["other.com"],
		});
		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toMatchObject({
			status: 403,
		});
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});
});

describe("ProxyService.fetch — onProgress forwarding to enqueueExactAndWait", () => {
	it("passes onProgress as the third argument when provided", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: ["other.com"],
		});
		const onProgress = jest.fn();

		await svc.fetch(TARGET_HTML_URL, TIME, onProgress);

		expect(client.enqueueExactAndWait).toHaveBeenCalledTimes(1);
		expect(client.enqueueExactAndWait).toHaveBeenCalledWith(TARGET_HTML_URL, TIME, onProgress);
		expect(client.enqueueExactAndWait.mock.calls[0]).toHaveLength(3);
	});

	it("calls enqueueExactAndWait with only 2 args when onProgress is not provided", async () => {
		const lookup = jest
			.fn<Promise<CacheHit | null>, [string, string]>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(htmlHit);
		const cache = makeCache(lookup);
		const client = makeClient();
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(cache, client, logger, {
			...baseConfig,
			whitelistHosts: ["other.com"],
		});

		await svc.fetch(TARGET_HTML_URL, TIME);

		expect(client.enqueueExactAndWait).toHaveBeenCalledTimes(1);
		expect(client.enqueueExactAndWait).toHaveBeenCalledWith(TARGET_HTML_URL, TIME);
		expect(client.enqueueExactAndWait.mock.calls[0]).toHaveLength(2);
	});
});

// --- CSS inlining -----------------------------------------------------------

describe("ProxyService.fetch — CSS inlining", () => {
	const INLINE_CSS_URL = "http://www.example.com/style.css";
	const CSS_TS = TIME;
	const CSS_CONTENT = "body { color: red; }";

	// baseConfig omits lockTime and cdxCacheEnabled; supply them so buildCssFetcher
	// receives a well-typed config and rewriteCssUrls gets lockTime=false rather than undefined.
	const inlineConfig = { ...baseConfig, lockTime: false, cdxCacheEnabled: false } as unknown as typeof baseConfig;

	const htmlWithLink = (href: string) =>
		`<html><head><link rel="stylesheet" href="${href}"></head><body>hello</body></html>`;

	it("inlines a cached stylesheet as a <style> block", async () => {
		const waybackHref = `/web/${CSS_TS}/${INLINE_CSS_URL}`;
		const html = htmlWithLink(waybackHref);

		// HTML page: cache HIT
		const htmlHitLocal: CacheHit = { absPath: "/cache/page.html", contentType: "text/html" };
		// CSS: cache HIT
		const cssHitLocal: CacheHit = { absPath: "/cache/style.css", contentType: "text/css" };

		const cacheLookup = jest
			.fn()
			.mockImplementation((url: string, _ts: string) => {
				if (url === TARGET_HTML_URL) return Promise.resolve(htmlHitLocal);
				if (url === INLINE_CSS_URL) return Promise.resolve(cssHitLocal);
				return Promise.resolve(null);
			});

		const cache = makeCache(cacheLookup);
		const client = makeClient();

		// readFile: first call returns HTML, second returns CSS
		mockedReadFile
			.mockResolvedValueOnce(Buffer.from(html))
			.mockResolvedValueOnce(Buffer.from(CSS_CONTENT));

		const svc = new ProxyService(cache, client, logger, inlineConfig);
		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(String(result.body)).toContain(`<style>${CSS_CONTENT}</style>`);
		expect(String(result.body)).not.toContain('<link rel="stylesheet"');
	});

	it("inlines a stylesheet fetched live (cache miss, directClient available)", async () => {
		const waybackHref = `/web/${CSS_TS}/${INLINE_CSS_URL}`;
		const html = htmlWithLink(waybackHref);

		const htmlHitLocal: CacheHit = { absPath: "/cache/page.html", contentType: "text/html" };
		const cssHitAfterWrite: CacheHit = { absPath: "/cache/style.css", contentType: "text/css" };
		// First CSS lookup → miss; second (after writeStream) → hit
		let cssLookupCalls = 0;
		const cacheLookup = jest
			.fn()
			.mockImplementation((url: string, _ts: string) => {
				if (url === TARGET_HTML_URL) return Promise.resolve(htmlHitLocal);
				if (url === INLINE_CSS_URL) {
					cssLookupCalls++;
					if (cssLookupCalls >= 2) return Promise.resolve(cssHitAfterWrite);
				}
				return Promise.resolve(null);
			});

		const cache = makeCache(cacheLookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValueOnce({
			outcome: "ok",
			body: Readable.from([Buffer.from(CSS_CONTENT)]),
			contentType: "text/css",
		});

		// readFile: HTML first, then CSS from cache hit path
		mockedReadFile
			.mockResolvedValueOnce(Buffer.from(html))
			.mockResolvedValueOnce(Buffer.from(CSS_CONTENT));

		const svc = new ProxyService(cache, client, logger, inlineConfig, null, directClient);
		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(String(result.body)).toContain(`<style>${CSS_CONTENT}</style>`);
		expect(String(result.body)).not.toContain('<link rel="stylesheet"');
		expect(cache.writeStream).toHaveBeenCalledWith(INLINE_CSS_URL, CSS_TS, expect.any(Readable));
		expect(cache.writeContentTypeSidecar).toHaveBeenCalledWith(INLINE_CSS_URL, CSS_TS, "text/css");
		expect(cache.writeResolvedTimeSidecar).not.toHaveBeenCalled();
	});

	it("leaves <link> intact when CSS fetch fails", async () => {
		const waybackHref = `/web/${CSS_TS}/${INLINE_CSS_URL}`;
		const html = htmlWithLink(waybackHref);

		const htmlHitLocal: CacheHit = { absPath: "/cache/page.html", contentType: "text/html" };
		const cacheLookup = jest
			.fn()
			.mockImplementation((url: string, _ts: string) => {
				if (url === TARGET_HTML_URL) return Promise.resolve(htmlHitLocal);
				return Promise.resolve(null);
			});

		const cache = makeCache(cacheLookup);
		const client = makeClient();
		const directClient = makeDirectClient();
		directClient.fetchAtRequestedTime.mockResolvedValueOnce({ outcome: "not_found" });

		mockedReadFile.mockResolvedValueOnce(Buffer.from(html));

		const svc = new ProxyService(cache, client, logger, inlineConfig, null, directClient);
		const result = await svc.fetch(TARGET_HTML_URL, TIME);

		expect(String(result.body)).toContain('<link rel="stylesheet"');
		expect(String(result.body)).not.toContain("<style>");
		expect(directClient.fetchAtRequestedTime).toHaveBeenCalledWith(INLINE_CSS_URL, CSS_TS);
	});
});

// --- Operator blocklist (config.json at the cache-bucket root) --------------

describe("ProxyService.fetch — blocked domains", () => {
	const makeBlocklist = (blockedHosts: string[]) =>
		({
			isBlocked: jest.fn(async (host: string) => blockedHosts.includes(host)),
		}) as unknown as import("../../src/lib/blocklist").BlocklistService;

	it("throws 451 before touching the cache, direct client, or worker queue", async () => {
		const cache = makeCache();
		const client = makeClient();
		const directClient = makeDirectClient();
		const blocklist = makeBlocklist(["example.com"]);
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient, blocklist);

		await expect(svc.fetch(TARGET_HTML_URL, TIME)).rejects.toMatchObject({
			status: 451,
			message: "Domain blocked: example.com",
		});
		expect(cache.lookup).not.toHaveBeenCalled();
		expect(directClient.fetchAtRequestedTime).not.toHaveBeenCalled();
		expect(client.enqueueExactAndWait).not.toHaveBeenCalled();
	});

	it("451 is not swallowed by the CDN-fallback retry loop", async () => {
		const cache = makeCache();
		const client = makeClient();
		const blocklist = makeBlocklist(["example.com"]);
		const svc = new ProxyService(cache, client, logger, baseConfig, null, null, blocklist);

		// A CDN-shaped URL would produce fallback candidates on 404 — a 451 must
		// propagate as-is instead of entering that loop.
		await expect(svc.fetch("http://example.com/img.png", TIME)).rejects.toMatchObject({
			status: 451,
		});
	});

	it("serves normally when the blocklist does not match", async () => {
		const cache = makeCache(jest.fn().mockResolvedValue(htmlHit));
		const client = makeClient();
		const blocklist = makeBlocklist(["other.com"]);
		mockedReadFile.mockResolvedValue(Buffer.from(PLAIN_HTML_BODY));
		const svc = new ProxyService(cache, client, logger, baseConfig, null, null, blocklist);

		const result = await svc.fetch(TARGET_HTML_URL, TIME);
		expect(result.cache).toBe("HIT");
	});

	it("prewarm skips assets on blocked domains but fetches the rest", async () => {
		// Page host is allowed; HTML embeds one asset on a blocked host and one
		// on an allowed host.
		const pageUrl = "http://ok.com/page";
		const html =
			'<html><body><img src="/web/20200101000000/http://blocked.com/pixel.gif">' +
			'<img src="/web/20200101000000/http://ok.com/logo.png"></body></html>';
		const cache = makeCache(jest.fn().mockResolvedValue(htmlHit));
		const client = makeClient();
		const directClient = makeDirectClient();
		const blocklist = makeBlocklist(["blocked.com"]);
		mockedReadFile.mockResolvedValue(Buffer.from(html));
		const svc = new ProxyService(cache, client, logger, baseConfig, null, directClient, blocklist);

		const result = await svc.fetch(pageUrl, TIME);
		expect(result.cache).toBe("HIT");
		await svc.drainPrewarms();

		const prewarmedUrls = directClient.fetchAtResolvedTime.mock.calls.map((c) => c[0]);
		expect(prewarmedUrls).toContain("http://ok.com/logo.png");
		expect(prewarmedUrls).not.toContain("http://blocked.com/pixel.gif");
	});

	it("triggerDomainCrawl rejects a blocked host with 451", async () => {
		const cache = makeCache();
		const client = makeClient();
		const blocklist = makeBlocklist(["example.com"]);
		const svc = new ProxyService(
			cache,
			client,
			logger,
			{ ...baseConfig, domainCrawlEnabled: true },
			null,
			null,
			blocklist,
		);

		await expect(svc.triggerDomainCrawl("example.com", TIME)).rejects.toMatchObject({
			status: 451,
		});
		expect(client.enqueueDomainCrawl).not.toHaveBeenCalled();
	});
});
