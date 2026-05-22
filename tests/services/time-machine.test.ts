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
};

type ProxyMock = jest.Mocked<Pick<ProxyService, "fetch">>;

const makeService = (proxyFetch?: ProxyMock["fetch"]) => {
	const proxy = {
		fetch: proxyFetch ?? jest.fn(),
		fetchAndCacheImage: jest.fn(),
		prefetchResources: jest.fn(),
		prefetchResourceUrls: jest.fn(),
		getCachedResourceUrls: jest.fn(),
	} as unknown as ProxyService;
	const cache = {
		handleCacheClear: jest.fn(),
	} as unknown as CacheService;
	const validator = {
		validateTargetUrl: jest.fn((url: string) => url),
		isHostWhitelisted: jest.fn(() => true),
	};
	const shutdown = new ShutdownController();
	const svc = new TimeMachineService(config, proxy, cache, validator, shutdown, logger);
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
});
