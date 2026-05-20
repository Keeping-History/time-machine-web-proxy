import pino from "pino";
import type { WaybackClient } from "../../src/clients/wayback";
import type { CacheEntry } from "../../src/models/cache";
import type { CacheService } from "../../src/services/cache";
import { ProxyService } from "../../src/services/proxy";

const ARCHIVE_PREFIX = "https://web.archive.org/web";
const PROXY_BASE = "http://localhost:8080";
const TIME = "20200101000000";
const TARGET_URL = "http://example.com/page";
const ARCHIVE_URL = `${ARCHIVE_PREFIX}/${TIME}/${TARGET_URL}`;

const logger = pino({ level: "silent" });

const htmlEntry: CacheEntry = {
	contentType: "text/html",
	archiveUrl: ARCHIVE_URL,
	archiveTime: TIME,
	body: "<html><head></head><body>hello</body></html>",
	isHtml: true,
	isCss: false,
};

const cssEntry: CacheEntry = {
	contentType: "text/css",
	archiveUrl: ARCHIVE_URL,
	archiveTime: TIME,
	body: "body { color: red; }",
	isHtml: false,
	isCss: true,
};

const makeService = (
	cacheOverrides: Partial<Pick<CacheService, "get" | "put">> = {},
	waybackOverrides: Partial<Pick<WaybackClient, "fetch">> = {},
) => {
	const cache = {
		get: jest.fn().mockResolvedValue(null),
		put: jest.fn().mockResolvedValue(undefined),
		handleCacheClear: jest.fn(),
		...cacheOverrides,
	} as unknown as CacheService;

	const wayback = {
		fetch: jest.fn().mockResolvedValue(new Response(null, { status: 200 })),
		...waybackOverrides,
	} as unknown as WaybackClient;

	const svc = new ProxyService(cache, wayback, logger, {
		proxyBase: PROXY_BASE,
		archivePrefix: ARCHIVE_PREFIX,
		proxyPrefix: "",
	});

	return {
		svc,
		cache: cache as jest.Mocked<CacheService>,
		wayback: wayback as jest.Mocked<WaybackClient>,
	};
};

beforeEach(() => jest.resetAllMocks());

describe("ProxyService.fetch — cache HIT", () => {
	it("returns cached HTML entry with cache=HIT without calling wayback", async () => {
		const { svc, wayback } = makeService({ get: jest.fn().mockResolvedValue(htmlEntry) });
		const result = await svc.fetch(TARGET_URL, TIME);
		expect(result.cache).toBe("HIT");
		expect(result.contentType).toBe("text/html");
		expect(wayback.fetch).not.toHaveBeenCalled();
	});

	it("returns cached CSS entry with cache=HIT", async () => {
		const { svc } = makeService({ get: jest.fn().mockResolvedValue(cssEntry) });
		const result = await svc.fetch(TARGET_URL, TIME);
		expect(result.cache).toBe("HIT");
		expect(result.contentType).toBe("text/css");
	});

	it("returns cached binary as a Buffer", async () => {
		const binaryEntry: CacheEntry = {
			...cssEntry,
			contentType: "image/png",
			isCss: false,
			body: Buffer.from([1, 2, 3]).toString("base64"),
		};
		const { svc } = makeService({ get: jest.fn().mockResolvedValue(binaryEntry) });
		const result = await svc.fetch(TARGET_URL, TIME);
		expect(result.cache).toBe("HIT");
		expect(result.body).toBeInstanceOf(Buffer);
	});
});

describe("ProxyService.fetch — cache MISS", () => {
	const _makeHtmlFetch = (body: string, url = ARCHIVE_URL) =>
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/html", "x-archive-orig-content-type": "text/html" },
			url,
		} as ResponseInit & { url: string });

	it("fetches from archive, caches, and returns MISS on HTML", async () => {
		const html = "<html><head></head><body>archive</body></html>";
		const { svc, cache, wayback } = makeService();
		wayback.fetch.mockResolvedValue(
			new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
		);
		const result = await svc.fetch(TARGET_URL, TIME);
		expect(result.cache).toBe("MISS");
		expect(cache.put).toHaveBeenCalledTimes(1);
		const [putUrl, putTime, putEntry] = cache.put.mock.calls[0];
		expect(putUrl).toBe(TARGET_URL);
		expect(putTime).toBe(TIME);
		expect(putEntry.isHtml).toBe(true);
	});

	it("fetches and caches CSS with isCss=true", async () => {
		const { svc, cache, wayback } = makeService();
		wayback.fetch.mockResolvedValue(
			new Response("body{}", { status: 200, headers: { "content-type": "text/css" } }),
		);
		const result = await svc.fetch(TARGET_URL, TIME);
		expect(result.cache).toBe("MISS");
		const [, , putEntry] = cache.put.mock.calls[0];
		expect(putEntry.isCss).toBe(true);
	});

	it("fetches binary and stores body as base64", async () => {
		const { svc, cache, wayback } = makeService();
		wayback.fetch.mockResolvedValue(
			new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { "content-type": "image/png" },
			}),
		);
		const result = await svc.fetch(TARGET_URL, TIME);
		expect(result.cache).toBe("MISS");
		const [, , putEntry] = cache.put.mock.calls[0];
		expect(putEntry.isHtml).toBe(false);
		expect(putEntry.isCss).toBe(false);
		expect(result.body).toBeInstanceOf(Buffer);
	});

	it("throws with status 404 when archive returns x-ts:404 header", async () => {
		const { svc, wayback } = makeService();
		wayback.fetch.mockResolvedValue(
			new Response(null, { status: 200, headers: { "x-ts": "404" } }),
		);
		await expect(svc.fetch(TARGET_URL, TIME)).rejects.toMatchObject({ status: 404 });
	});

	it("throws with archive status for non-ok responses", async () => {
		const { svc, wayback } = makeService();
		wayback.fetch.mockResolvedValue(new Response(null, { status: 503 }));
		await expect(svc.fetch(TARGET_URL, TIME)).rejects.toMatchObject({ status: 503 });
	});
});

describe("ProxyService.fetchAndCacheImage", () => {
	it("returns true and does not fetch when already cached", async () => {
		const imgEntry: CacheEntry = { ...cssEntry, contentType: "image/png" };
		const { svc, wayback } = makeService({ get: jest.fn().mockResolvedValue(imgEntry) });
		const result = await svc.fetchAndCacheImage("http://example.com/img.png", TIME);
		expect(result).toBe(true);
		expect(wayback.fetch).not.toHaveBeenCalled();
	});

	it("fetches, caches, and returns true on success", async () => {
		const { svc, cache, wayback } = makeService();
		wayback.fetch.mockResolvedValue(
			new Response(new Uint8Array([1, 2]), {
				status: 200,
				headers: { "content-type": "image/png" },
			}),
		);
		const result = await svc.fetchAndCacheImage("http://example.com/img.png", TIME);
		expect(result).toBe(true);
		expect(cache.put).toHaveBeenCalledTimes(1);
	});

	it("returns false when archive response is not ok", async () => {
		const { svc, wayback } = makeService();
		wayback.fetch.mockResolvedValue(new Response(null, { status: 404 }));
		expect(await svc.fetchAndCacheImage("http://example.com/img.png", TIME)).toBe(false);
	});
});
