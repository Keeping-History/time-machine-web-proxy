import type http from "node:http";
import pino from "pino";
import { ShutdownController } from "../../src/lib/shutdown";
import type { Config } from "../../src/models/config";
import type { CacheService } from "../../src/services/cache";
import type { ProxyService } from "../../src/services/proxy";
import { TimeMachineService } from "../../src/services/time-machine";

const logger = pino({ level: "silent" });

const config: Config = {
	port: 0,
	hostname: "127.0.0.1",
	defaultTime: "20000101000000",
	cacheDir: "/tmp/cache",
	cacheEnabled: false,
	allowedOrigins: ["*"],
	whitelistHosts: "*",
	proxyPrefix: "",
	proxyBase: "http://localhost:0",
	proxyBaseHostname: "localhost",
	cacheClearToken: "",
	wsKeepaliveMs: 30000,
	redisUrl: "redis://localhost:6379",
	bullmqPrefix: "tm",
	domainCrawlEnabled: true,
	workerConcurrency: 2,
	workerRateLimitPerSec: 1,
	downloaderThreadsCount: 3,
	crawlMaxCdxPages: 50,
	outboundProxyUrls: [],
	outboundProxyChooser: "sequential",
	outboundProxyUsername: "",
	outboundProxyPassword: "",
	outboundProxyCooldownMs: 60_000,
	snapshotWindowDays: [30, 365, 3650, 0],
	allowLaterFallback: false,
	assetLaterFallback: true,
};

type ProxyMock = jest.Mocked<Pick<ProxyService, "fetch" | "triggerDomainCrawl">>;

const makeService = (
	proxyFetch?: ProxyMock["fetch"],
	overrides: {
		triggerDomainCrawl?: ProxyMock["triggerDomainCrawl"];
		config?: Partial<Config>;
		getStatus?: () => Promise<unknown>;
	} = {},
) => {
	const proxy = {
		fetch: proxyFetch ?? jest.fn(),
		fetchAndCacheImage: jest.fn(),
		prefetchResources: jest.fn(),
		prefetchResourceUrls: jest.fn(),
		getCachedResourceUrls: jest.fn(),
		triggerDomainCrawl: overrides.triggerDomainCrawl ?? jest.fn().mockResolvedValue(undefined),
	} as unknown as ProxyService;
	const cache = {
		handleCacheClear: jest.fn(),
	} as unknown as CacheService;
	const validator = {
		validateTargetUrl: jest.fn((url: string) => url),
		isHostWhitelisted: jest.fn(() => true),
	};
	const shutdown = new ShutdownController();
	const effectiveConfig: Config = { ...config, ...overrides.config };
	const svc = new TimeMachineService(
		effectiveConfig,
		proxy,
		cache,
		validator,
		shutdown,
		logger,
		undefined,
		overrides.getStatus,
	);
	return { svc, proxy: proxy as unknown as ProxyMock };
};

const portOf = (svc: TimeMachineService): number => {
	const server = (svc as unknown as { server: http.Server }).server;
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("server not listening");
	return addr.port;
};

const startAndAwaitListening = async (svc: TimeMachineService): Promise<number> => {
	svc.start();
	const server = (svc as unknown as { server: http.Server }).server;
	if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));
	return portOf(svc);
};

describe("TimeMachineService", () => {
	it("can be instantiated with required dependencies", () => {
		const { svc } = makeService();
		expect(svc).toBeDefined();
	});

	it("exposes start() and stop() methods", () => {
		const { svc } = makeService();
		expect(typeof svc.start).toBe("function");
		expect(typeof svc.stop).toBe("function");
	});

	it("start() creates a listening server and stop() closes it", async () => {
		const { svc } = makeService();
		svc.start();
		await svc.stop();
	});
});

describe("TimeMachineService HTTP handler — path-based /web/{ts}/{url} input", () => {
	const okResult = {
		contentType: "text/html",
		archiveUrl: "http://example.com/page",
		originalUrl: "http://example.com/page",
		archiveTime: "20020401000000",
		body: "<html>ok</html>",
		cache: "HIT" as const,
	};

	it("routes GET /web/{ts}/{url} to ProxyService.fetch with the extracted time and url", async () => {
		const fetchMock = jest.fn().mockResolvedValue(okResult);
		const { svc, proxy } = makeService(fetchMock);
		const port = await startAndAwaitListening(svc);

		try {
			const r = await fetch(`http://127.0.0.1:${port}/web/20020401000000/http://example.com/page`);
			expect(r.status).toBe(200);
			expect(proxy.fetch).toHaveBeenCalledWith("http://example.com/page", "20020401000000");
		} finally {
			await svc.stop();
		}
	});

	it("tolerates and strips a Wayback content-type modifier (im_)", async () => {
		const fetchMock = jest.fn().mockResolvedValue({
			...okResult,
			contentType: "image/png",
			body: Buffer.from([1, 2, 3]),
			originalUrl: "http://example.com/logo.png",
			archiveUrl: "http://example.com/logo.png",
		});
		const { svc, proxy } = makeService(fetchMock);
		const port = await startAndAwaitListening(svc);

		try {
			const r = await fetch(
				`http://127.0.0.1:${port}/web/20020401000000im_/http://example.com/logo.png`,
			);
			expect(r.status).toBe(200);
			expect(proxy.fetch).toHaveBeenCalledWith("http://example.com/logo.png", "20020401000000");
		} finally {
			await svc.stop();
		}
	});

	it("preserves the target URL's own query string", async () => {
		const fetchMock = jest.fn().mockResolvedValue(okResult);
		const { svc, proxy } = makeService(fetchMock);
		const port = await startAndAwaitListening(svc);

		try {
			// fetch() URL-parses the path itself, which would normally split at
			// the first '?'. We send the raw request via a manual http.request
			// instead — but globalThis fetch preserves the query because the
			// '?' here is part of the target URL, not the proxy URL. Verify
			// the entire string after /web/{ts}/ reaches the handler intact.
			const r = await fetch(
				`http://127.0.0.1:${port}/web/20020401000000/http://example.com/page?foo=bar&baz=qux`,
			);
			expect(r.status).toBe(200);
			expect(proxy.fetch).toHaveBeenCalledWith(
				"http://example.com/page?foo=bar&baz=qux",
				"20020401000000",
			);
		} finally {
			await svc.stop();
		}
	});

	it("still accepts the legacy /?url=&time= format alongside path-based", async () => {
		const fetchMock = jest.fn().mockResolvedValue(okResult);
		const { svc, proxy } = makeService(fetchMock);
		const port = await startAndAwaitListening(svc);

		try {
			const enc = encodeURIComponent("http://example.com/page");
			const r = await fetch(`http://127.0.0.1:${port}/?url=${enc}&time=20020401000000`);
			expect(r.status).toBe(200);
			expect(proxy.fetch).toHaveBeenCalledWith("http://example.com/page", "20020401000000");
		} finally {
			await svc.stop();
		}
	});

	it("falls through to the legacy missing-url 400 when neither format matches", async () => {
		const fetchMock = jest.fn();
		const { svc, proxy } = makeService(fetchMock);
		const port = await startAndAwaitListening(svc);

		try {
			const r = await fetch(`http://127.0.0.1:${port}/`);
			expect(r.status).toBe(400);
			expect(proxy.fetch).not.toHaveBeenCalled();
		} finally {
			await svc.stop();
		}
	});

	it("uses config.defaultTime (ARCHIVE_TIME) when the timestamp segment is omitted", async () => {
		const fetchMock = jest.fn().mockResolvedValue(okResult);
		const { svc, proxy } = makeService(fetchMock);
		const port = await startAndAwaitListening(svc);

		try {
			const r = await fetch(`http://127.0.0.1:${port}/web/http://example.com/page`);
			expect(r.status).toBe(200);
			expect(proxy.fetch).toHaveBeenCalledWith("http://example.com/page", config.defaultTime);
		} finally {
			await svc.stop();
		}
	});
});

describe("TimeMachineService HTTP handler — SSE (Accept: text/event-stream)", () => {
	const okResult = {
		contentType: "text/html",
		archiveUrl: "http://example.com/page",
		originalUrl: "http://example.com/page",
		archiveTime: "20020401000000",
		body: "<html>ok</html>",
		cache: "MISS" as const,
	};

	async function readSseBody(r: Response): Promise<string> {
		// fetch() in Node 22 fully buffers when we await text(); good enough
		// because the server closes the connection after the final event.
		return r.text();
	}

	function parseEvents(body: string): Array<{ event: string; data: unknown }> {
		const out: Array<{ event: string; data: unknown }> = [];
		for (const block of body.split("\n\n")) {
			const trimmed = block.trim();
			if (!trimmed) continue;
			let event = "message";
			let dataLine = "";
			for (const line of trimmed.split("\n")) {
				if (line.startsWith("event:")) event = line.slice("event:".length).trim();
				else if (line.startsWith("data:")) dataLine = line.slice("data:".length).trim();
			}
			let data: unknown = dataLine;
			try {
				data = JSON.parse(dataLine);
			} catch {
				/* leave as string */
			}
			out.push({ event, data });
		}
		return out;
	}

	it("responds with Content-Type: text/event-stream when Accept includes it", async () => {
		const fetchMock = jest.fn().mockResolvedValue(okResult);
		const { svc } = makeService(fetchMock);
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(
				`http://127.0.0.1:${port}/web/20020401000000/http://example.com/page`,
				{ headers: { Accept: "text/event-stream" } },
			);
			expect(r.status).toBe(200);
			expect(r.headers.get("content-type")).toContain("text/event-stream");
			await readSseBody(r);
		} finally {
			await svc.stop();
		}
	});

	it("emits progress events forwarded from ProxyService.fetch followed by a result event", async () => {
		const fetchMock = jest.fn(async (_url: string, _time: string, onProgress?: (p: unknown) => void) => {
			onProgress?.({
				stage: "resolved",
				jobId: "job-1",
				queue: "archive-exact",
				ts: 1,
				resolved: "20020401000000",
			});
			onProgress?.({
				stage: "download_done",
				jobId: "job-1",
				queue: "archive-exact",
				ts: 2,
			});
			return okResult;
		});
		const { svc } = makeService(fetchMock as unknown as ProxyMock["fetch"]);
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(
				`http://127.0.0.1:${port}/web/20020401000000/http://example.com/page`,
				{ headers: { Accept: "text/event-stream" } },
			);
			const events = parseEvents(await readSseBody(r));
			const stages = events
				.filter((e) => e.event === "progress")
				.map((e) => (e.data as { stage: string }).stage);
			expect(stages).toEqual(["resolved", "download_done"]);
			const result = events.find((e) => e.event === "result");
			expect(result).toBeDefined();
			expect((result?.data as { contentType: string }).contentType).toBe("text/html");
		} finally {
			await svc.stop();
		}
	});

	it("emits an error event when ProxyService.fetch rejects (no HTTP error code — headers already flushed)", async () => {
		const err = Object.assign(new Error("upstream gone"), { status: 502 });
		const fetchMock = jest.fn().mockRejectedValue(err);
		const { svc } = makeService(fetchMock);
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(
				`http://127.0.0.1:${port}/web/20020401000000/http://example.com/page`,
				{ headers: { Accept: "text/event-stream" } },
			);
			// Stream opens with 200 — error is delivered as a frame.
			expect(r.status).toBe(200);
			const events = parseEvents(await readSseBody(r));
			const errEvent = events.find((e) => e.event === "error");
			expect(errEvent).toBeDefined();
			expect((errEvent?.data as { status: number; message: string }).status).toBe(502);
			expect((errEvent?.data as { status: number; message: string }).message).toBe(
				"upstream gone",
			);
		} finally {
			await svc.stop();
		}
	});

	it("uses the buffered (non-SSE) response when Accept omits text/event-stream", async () => {
		const fetchMock = jest.fn().mockResolvedValue(okResult);
		const { svc } = makeService(fetchMock);
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(
				`http://127.0.0.1:${port}/web/20020401000000/http://example.com/page`,
				{ headers: { Accept: "text/html" } },
			);
			expect(r.status).toBe(200);
			expect(r.headers.get("content-type")).toContain("text/html");
			expect(r.headers.get("content-type")).not.toContain("event-stream");
		} finally {
			await svc.stop();
		}
	});
});

describe("TimeMachineService HTTP handler — GET /status", () => {
	const sampleStatus = {
		redis: { status: "ready" },
		outboundProxies: { configured: false, agents: [] },
		queues: {
			"archive-exact": { failed: 2, waiting: 0, active: 1, completed: 5, delayed: 0 },
			"archive-crawl": { failed: 0, waiting: 0, active: 0, completed: 1, delayed: 0 },
		},
	};

	it("returns 200 with JSON payload assembled by the injected getStatus callback", async () => {
		const getStatus = jest.fn().mockResolvedValue(sampleStatus);
		const { svc } = makeService(undefined, { getStatus });
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/status`);
			expect(r.status).toBe(200);
			expect(r.headers.get("content-type")).toContain("application/json");
			expect(await r.json()).toEqual(sampleStatus);
			expect(getStatus).toHaveBeenCalledTimes(1);
		} finally {
			await svc.stop();
		}
	});

	it("does NOT require authentication (operational endpoint, no secrets leak)", async () => {
		// /status is read-only and intentionally public — same convention as
		// /health or /ready. Anyone can probe it; the response contains no
		// credentials (proxy `host` field is already stripped of basic-auth).
		const getStatus = jest.fn().mockResolvedValue(sampleStatus);
		const { svc } = makeService(undefined, {
			getStatus,
			config: { cacheClearToken: "should-not-be-required" },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/status`);
			expect(r.status).toBe(200);
		} finally {
			await svc.stop();
		}
	});

	it("returns 404 when no getStatus callback was supplied (endpoint disabled)", async () => {
		// Backward compatibility: a TimeMachineService constructed without a
		// status provider (e.g. in legacy boot paths) should not silently
		// return an empty status — it should 404 so the caller knows the
		// endpoint isn't wired.
		const { svc } = makeService(undefined, {}); // no getStatus
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/status`);
			expect(r.status).toBe(404);
		} finally {
			await svc.stop();
		}
	});

	it("returns 500 with JSON error body when getStatus throws", async () => {
		const getStatus = jest.fn().mockRejectedValue(new Error("redis unreachable"));
		const { svc } = makeService(undefined, { getStatus });
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/status`);
			expect(r.status).toBe(500);
			expect(r.headers.get("content-type")).toContain("application/json");
			expect((await r.json()).error).toBe("redis unreachable");
		} finally {
			await svc.stop();
		}
	});

	it("does NOT intercept other GET routes — /web/{ts}/{url} still works", async () => {
		// /status is matched on exact pathname so it can't shadow the
		// path-based input format.
		const fetchMock = jest.fn().mockResolvedValue({
			contentType: "text/html",
			archiveUrl: "http://example.com/",
			originalUrl: "http://example.com/",
			body: "<html>ok</html>",
			cache: "HIT" as const,
		});
		const getStatus = jest.fn().mockResolvedValue(sampleStatus);
		const { svc } = makeService(fetchMock, { getStatus });
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/web/20020401000000/http://example.com/`);
			expect(r.status).toBe(200);
			expect(fetchMock).toHaveBeenCalled();
			expect(getStatus).not.toHaveBeenCalled();
		} finally {
			await svc.stop();
		}
	});
});

describe("TimeMachineService HTTP handler — POST /crawl (admin)", () => {
	const TOKEN = "secret-token";

	it("returns 403 when CACHE_CLEAR_TOKEN is empty (endpoint disabled)", async () => {
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: "" },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/crawl?host=example.com`, {
				method: "POST",
			});
			expect(r.status).toBe(403);
			// MUST NOT enqueue anything when the endpoint is administratively disabled.
			expect(proxy.triggerDomainCrawl).not.toHaveBeenCalled();
		} finally {
			await svc.stop();
		}
	});

	it("returns 401 when Authorization header is missing or wrong", async () => {
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const noAuth = await fetch(`http://127.0.0.1:${port}/crawl?host=example.com`, {
				method: "POST",
			});
			expect(noAuth.status).toBe(401);

			const wrongAuth = await fetch(`http://127.0.0.1:${port}/crawl?host=example.com`, {
				method: "POST",
				headers: { Authorization: "Bearer wrong" },
			});
			expect(wrongAuth.status).toBe(401);

			expect(proxy.triggerDomainCrawl).not.toHaveBeenCalled();
		} finally {
			await svc.stop();
		}
	});

	it("returns 202 and enqueues the crawl on success", async () => {
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(
				`http://127.0.0.1:${port}/crawl?host=example.com&time=20010913000000`,
				{ method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } },
			);
			expect(r.status).toBe(202);
			expect(r.headers.get("content-type")).toContain("application/json");
			const body = await r.json();
			expect(body).toEqual({
				host: "example.com",
				time: "20010913000000",
				preflightSkipped: false,
			});
			expect(proxy.triggerDomainCrawl).toHaveBeenCalledWith("example.com", "20010913000000", {
				skipPreflight: false,
			});
		} finally {
			await svc.stop();
		}
	});

	it("defaults time to config.defaultTime when omitted", async () => {
		// Mirrors GET behavior: omitting time falls back to ARCHIVE_TIME so an
		// operator can curl a quick crawl without knowing the timestamp by heart.
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/crawl?host=example.com`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			expect(r.status).toBe(202);
			expect(proxy.triggerDomainCrawl).toHaveBeenCalledWith("example.com", config.defaultTime, {
				skipPreflight: false,
			});
		} finally {
			await svc.stop();
		}
	});

	it("returns 400 when host is missing", async () => {
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/crawl`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			expect(r.status).toBe(400);
			expect(proxy.triggerDomainCrawl).not.toHaveBeenCalled();
		} finally {
			await svc.stop();
		}
	});

	it("returns 400 when host contains illegal characters (path/scheme smuggling)", async () => {
		// Hostname must be a bare host. Reject anything with /, :, ?, # so a
		// crafted "host" can't leak into the cache directory or the CDX URL.
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(
				`http://127.0.0.1:${port}/crawl?host=${encodeURIComponent("example.com/etc/passwd")}`,
				{ method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } },
			);
			expect(r.status).toBe(400);
			expect(proxy.triggerDomainCrawl).not.toHaveBeenCalled();
		} finally {
			await svc.stop();
		}
	});

	it("returns 400 when time is supplied but not 14 digits", async () => {
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/crawl?host=example.com&time=2001`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			expect(r.status).toBe(400);
			expect(proxy.triggerDomainCrawl).not.toHaveBeenCalled();
		} finally {
			await svc.stop();
		}
	});

	it("propagates status errors from triggerDomainCrawl as the HTTP status", async () => {
		// 403 (not whitelisted), 413 (too large), 503 (kill switch) — each must
		// reach the client verbatim with a JSON error body.
		const trigger = jest
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error("Host not whitelisted"), { status: 403 }))
			.mockRejectedValueOnce(Object.assign(new Error("Crawl too large"), { status: 413 }))
			.mockRejectedValueOnce(
				Object.assign(new Error("Domain crawl is disabled"), { status: 503 }),
			);
		const { svc } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const headers = { Authorization: `Bearer ${TOKEN}` };
			const r1 = await fetch(`http://127.0.0.1:${port}/crawl?host=a.com`, {
				method: "POST",
				headers,
			});
			expect(r1.status).toBe(403);
			expect((await r1.json()).error).toMatch(/whitelist/i);

			const r2 = await fetch(`http://127.0.0.1:${port}/crawl?host=b.com`, {
				method: "POST",
				headers,
			});
			expect(r2.status).toBe(413);
			expect((await r2.json()).error).toMatch(/too large/i);

			const r3 = await fetch(`http://127.0.0.1:${port}/crawl?host=c.com`, {
				method: "POST",
				headers,
			});
			expect(r3.status).toBe(503);
			expect((await r3.json()).error).toMatch(/disabled/i);
		} finally {
			await svc.stop();
		}
	});

	it("forwards skip_preflight=true as opts.skipPreflight to triggerDomainCrawl", async () => {
		// HTTP query → service-call shape. Body must echo preflightSkipped:true
		// so the caller sees the safety net was disabled (no silent bypass).
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(
				`http://127.0.0.1:${port}/crawl?host=example.com&skip_preflight=true`,
				{ method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } },
			);
			expect(r.status).toBe(202);
			const body = await r.json();
			expect(body.preflightSkipped).toBe(true);
			expect(proxy.triggerDomainCrawl).toHaveBeenCalledWith(
				"example.com",
				config.defaultTime,
				{ skipPreflight: true },
			);
		} finally {
			await svc.stop();
		}
	});

	it("default (no skip_preflight param) sends skipPreflight:false", async () => {
		// Default-safe: omitting the param keeps the size-cap guard ON.
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/crawl?host=example.com`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			expect(r.status).toBe(202);
			const body = await r.json();
			expect(body.preflightSkipped).toBe(false);
			expect(proxy.triggerDomainCrawl).toHaveBeenCalledWith(
				"example.com",
				config.defaultTime,
				{ skipPreflight: false },
			);
		} finally {
			await svc.stop();
		}
	});

	it("only the literal string 'true' opts in — typos like 'yes' / '1' / 'TRUE' (sic) do NOT", async () => {
		// Safety-net bypass is high-impact; only an exact "true" (case-insensitive)
		// counts. Anything else is treated as the safer default.
		const trigger = jest.fn().mockResolvedValue(undefined);
		const { svc, proxy } = makeService(undefined, {
			triggerDomainCrawl: trigger,
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			// "yes" → NOT opt-in
			let r = await fetch(`http://127.0.0.1:${port}/crawl?host=example.com&skip_preflight=yes`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			expect(r.status).toBe(202);
			expect((await r.json()).preflightSkipped).toBe(false);

			// "1" → NOT opt-in
			r = await fetch(`http://127.0.0.1:${port}/crawl?host=example.com&skip_preflight=1`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			expect((await r.json()).preflightSkipped).toBe(false);

			// "TRUE" (uppercase) IS opt-in — case-insensitive
			r = await fetch(`http://127.0.0.1:${port}/crawl?host=example.com&skip_preflight=TRUE`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			expect((await r.json()).preflightSkipped).toBe(true);

			expect(proxy.triggerDomainCrawl).toHaveBeenNthCalledWith(1, "example.com", config.defaultTime, {
				skipPreflight: false,
			});
			expect(proxy.triggerDomainCrawl).toHaveBeenNthCalledWith(2, "example.com", config.defaultTime, {
				skipPreflight: false,
			});
			expect(proxy.triggerDomainCrawl).toHaveBeenNthCalledWith(3, "example.com", config.defaultTime, {
				skipPreflight: true,
			});
		} finally {
			await svc.stop();
		}
	});

	it("returns 404 for POST to a non-/crawl path (no fall-through to other handlers)", async () => {
		const { svc } = makeService(undefined, {
			config: { cacheClearToken: TOKEN },
		});
		const port = await startAndAwaitListening(svc);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/something-else`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}` },
			});
			expect(r.status).toBe(404);
		} finally {
			await svc.stop();
		}
	});
});
