import { loadConfig } from "../../src/lib/config";

describe("loadConfig", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns correct defaults when no env vars are set", () => {
		delete process.env.TIMEMACHINE_PORT;
		delete process.env.ARCHIVE_TIME;
		delete process.env.LISTENER;
		delete process.env.CACHE_DIR;
		delete process.env.CACHE_ENABLED;
		delete process.env.CORS_ORIGIN;
		delete process.env.WHITELIST_HOSTS;
		delete process.env.PROXY_PREFIX;
		delete process.env.PROXY_BASE_URL;
		delete process.env.CACHE_CLEAR_TOKEN;
		delete process.env.WS_KEEPALIVE_MS;
		delete process.env.REDIS_URL;
		delete process.env.BULLMQ_PREFIX;
		delete process.env.DOMAIN_CRAWL_ENABLED;
		delete process.env.WORKER_CONCURRENCY;
		delete process.env.WORKER_RATE_LIMIT_PER_SEC;
		delete process.env.DOWNLOADER_THREADS_COUNT;
		delete process.env.CRAWL_MAX_CDX_PAGES;
		delete process.env.OUTBOUND_PROXY_URL;
		delete process.env.OUTBOUND_PROXY_USERNAME;
		delete process.env.OUTBOUND_PROXY_PASSWORD;
		delete process.env.SNAPSHOT_WINDOW_DAYS;
		delete process.env.ALLOW_LATER_FALLBACK;

		const config = loadConfig();

		expect(config.port).toBe(8765);
		expect(config.defaultTime).toBe("19980101000000");
		expect(config.hostname).toBe("0.0.0.0");
		expect(config.cacheDir).toBe("/app/cache");
		expect(config.cacheEnabled).toBe(true);
		expect(config.whitelistHosts).toBe("*");
		expect(config.proxyPrefix).toBe("");
		expect(config.cacheClearToken).toBe("");
		expect(config.wsKeepaliveMs).toBe(30_000);
		expect(config.redisUrl).toBe("redis://localhost:6379");
		expect(config.bullmqPrefix).toBe("tm");
		expect(config.domainCrawlEnabled).toBe(true);
		expect(config.workerConcurrency).toBe(2);
		expect(config.workerRateLimitPerSec).toBe(1);
		expect(config.downloaderThreadsCount).toBe(3);
		expect(config.crawlMaxCdxPages).toBe(50);
		expect(config.outboundProxyUrl).toBe("");
		expect(config.outboundProxyUsername).toBe("");
		expect(config.outboundProxyPassword).toBe("");
		expect(config.snapshotWindowDays).toEqual([30, 365, 3650, 0]);
		expect(config.allowLaterFallback).toBe(false);
	});

	it("parses SNAPSHOT_WINDOW_DAYS CSV into number[]", () => {
		process.env.SNAPSHOT_WINDOW_DAYS = "7,30,90,0";
		expect(loadConfig().snapshotWindowDays).toEqual([7, 30, 90, 0]);
	});

	it("trims whitespace in SNAPSHOT_WINDOW_DAYS entries", () => {
		process.env.SNAPSHOT_WINDOW_DAYS = " 7 , 30 , 90 ";
		expect(loadConfig().snapshotWindowDays).toEqual([7, 30, 90]);
	});

	it("throws on non-numeric SNAPSHOT_WINDOW_DAYS entries", () => {
		process.env.SNAPSHOT_WINDOW_DAYS = "30,abc,90";
		expect(() => loadConfig()).toThrow(/SNAPSHOT_WINDOW_DAYS/);
	});

	it("throws on negative SNAPSHOT_WINDOW_DAYS entries", () => {
		process.env.SNAPSHOT_WINDOW_DAYS = "30,-1,90";
		expect(() => loadConfig()).toThrow(/SNAPSHOT_WINDOW_DAYS/);
	});

	it("throws on empty SNAPSHOT_WINDOW_DAYS", () => {
		process.env.SNAPSHOT_WINDOW_DAYS = "";
		expect(() => loadConfig()).toThrow(/SNAPSHOT_WINDOW_DAYS/);
	});

	it("treats ALLOW_LATER_FALLBACK=true (case-insensitive) as true", () => {
		process.env.ALLOW_LATER_FALLBACK = "true";
		expect(loadConfig().allowLaterFallback).toBe(true);

		process.env.ALLOW_LATER_FALLBACK = "TRUE";
		expect(loadConfig().allowLaterFallback).toBe(true);

		process.env.ALLOW_LATER_FALLBACK = "True";
		expect(loadConfig().allowLaterFallback).toBe(true);
	});

	it("treats any ALLOW_LATER_FALLBACK value other than true as false", () => {
		process.env.ALLOW_LATER_FALLBACK = "false";
		expect(loadConfig().allowLaterFallback).toBe(false);

		process.env.ALLOW_LATER_FALLBACK = "yes";
		expect(loadConfig().allowLaterFallback).toBe(false);

		process.env.ALLOW_LATER_FALLBACK = "1";
		expect(loadConfig().allowLaterFallback).toBe(false);
	});

	it("reads values from env vars", () => {
		process.env.TIMEMACHINE_PORT = "9000";
		process.env.ARCHIVE_TIME = "20000101000000";
		process.env.CACHE_ENABLED = "false";
		process.env.CORS_ORIGIN = "https://example.com,https://other.com";
		process.env.WS_KEEPALIVE_MS = "60000";
		process.env.PROXY_BASE_URL = "https://proxy.example.com";

		const config = loadConfig();

		expect(config.port).toBe(9000);
		expect(config.defaultTime).toBe("20000101000000");
		expect(config.cacheEnabled).toBe(false);
		expect(config.allowedOrigins).toEqual(["https://example.com", "https://other.com"]);
		expect(config.wsKeepaliveMs).toBe(60_000);
		expect(config.proxyBase).toBe("https://proxy.example.com");
		expect(config.proxyBaseHostname).toBe("proxy.example.com");
	});

	it("derives proxyBaseHostname from proxyBase", () => {
		process.env.PROXY_BASE_URL = "https://timemachine.example.org:8080";
		const config = loadConfig();
		expect(config.proxyBaseHostname).toBe("timemachine.example.org");
	});

	it("throws on malformed PROXY_BASE_URL", () => {
		process.env.PROXY_BASE_URL = "not-a-valid-url";
		expect(() => loadConfig()).toThrow(/Invalid URL/);
	});

	it("treats CACHE_ENABLED=false (case-insensitive) as disabled", () => {
		process.env.CACHE_ENABLED = "FALSE";
		expect(loadConfig().cacheEnabled).toBe(false);

		process.env.CACHE_ENABLED = "False";
		expect(loadConfig().cacheEnabled).toBe(false);
	});

	it("treats any CACHE_ENABLED value other than false as enabled", () => {
		process.env.CACHE_ENABLED = "true";
		expect(loadConfig().cacheEnabled).toBe(true);

		process.env.CACHE_ENABLED = "yes";
		expect(loadConfig().cacheEnabled).toBe(true);
	});

	it("reads Redis and BullMQ env vars", () => {
		process.env.REDIS_URL = "redis://memorystore.internal:6379";
		process.env.BULLMQ_PREFIX = "custom";

		const config = loadConfig();

		expect(config.redisUrl).toBe("redis://memorystore.internal:6379");
		expect(config.bullmqPrefix).toBe("custom");
	});

	it("treats DOMAIN_CRAWL_ENABLED=false (case-insensitive) as disabled", () => {
		process.env.DOMAIN_CRAWL_ENABLED = "false";
		expect(loadConfig().domainCrawlEnabled).toBe(false);

		process.env.DOMAIN_CRAWL_ENABLED = "FALSE";
		expect(loadConfig().domainCrawlEnabled).toBe(false);

		process.env.DOMAIN_CRAWL_ENABLED = "False";
		expect(loadConfig().domainCrawlEnabled).toBe(false);
	});

	it("treats any DOMAIN_CRAWL_ENABLED value other than false as enabled", () => {
		process.env.DOMAIN_CRAWL_ENABLED = "true";
		expect(loadConfig().domainCrawlEnabled).toBe(true);

		process.env.DOMAIN_CRAWL_ENABLED = "yes";
		expect(loadConfig().domainCrawlEnabled).toBe(true);
	});

	it("reads worker and downloader integer env vars", () => {
		process.env.WORKER_CONCURRENCY = "5";
		process.env.WORKER_RATE_LIMIT_PER_SEC = "2";
		process.env.DOWNLOADER_THREADS_COUNT = "8";
		process.env.CRAWL_MAX_CDX_PAGES = "100";

		const config = loadConfig();

		expect(config.workerConcurrency).toBe(5);
		expect(config.workerRateLimitPerSec).toBe(2);
		expect(config.downloaderThreadsCount).toBe(8);
		expect(config.crawlMaxCdxPages).toBe(100);
	});

	it("reads outbound proxy env vars", () => {
		process.env.OUTBOUND_PROXY_URL = "http://proxymesh.example.com:31280";
		process.env.OUTBOUND_PROXY_USERNAME = "user";
		process.env.OUTBOUND_PROXY_PASSWORD = "secret";

		const config = loadConfig();

		expect(config.outboundProxyUrl).toBe("http://proxymesh.example.com:31280");
		expect(config.outboundProxyUsername).toBe("user");
		expect(config.outboundProxyPassword).toBe("secret");
	});
});
