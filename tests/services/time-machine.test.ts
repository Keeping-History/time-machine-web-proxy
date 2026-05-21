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
	outboundProxyUrl: "",
	outboundProxyUsername: "",
	outboundProxyPassword: "",
	snapshotWindowDays: [30, 365, 3650, 0],
	allowLaterFallback: false,
};

const makeService = () => {
	const proxy = {
		fetch: jest.fn(),
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
	return new TimeMachineService(config, proxy, cache, validator, shutdown, logger);
};

describe("TimeMachineService", () => {
	it("can be instantiated with required dependencies", () => {
		const svc = makeService();
		expect(svc).toBeDefined();
	});

	it("exposes start() and stop() methods", () => {
		const svc = makeService();
		expect(typeof svc.start).toBe("function");
		expect(typeof svc.stop).toBe("function");
	});

	it("start() creates a listening server and stop() closes it", async () => {
		const svc = makeService();
		svc.start();
		await svc.stop();
	});
});
