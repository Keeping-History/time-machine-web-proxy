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
		delete process.env.PROXY_BASE_URL;
		delete process.env.CACHE_CLEAR_TOKEN;
		delete process.env.WS_KEEPALIVE_MS;
		delete process.env.REDIS_URL;
		delete process.env.BULLMQ_PREFIX;
		delete process.env.DOMAIN_CRAWL_ENABLED;
		delete process.env.WORKER_CONCURRENCY;
		delete process.env.WORKER_RATE_LIMIT_PER_SEC;
		delete process.env.CRAWL_MAX_CDX_PAGES;
		delete process.env.OUTBOUND_PROXY_URLS;
		delete process.env.OUTBOUND_PROXY_USERNAME;
		delete process.env.OUTBOUND_PROXY_PASSWORD;

		const config = loadConfig();

		expect(config.port).toBe(8765);
		expect(config.defaultTime).toBe("19980101000000");
		expect(config.hostname).toBe("0.0.0.0");
		expect(config.cacheDir).toBe("/app/cache");
		expect(config.cacheEnabled).toBe(true);
		expect(config.whitelistHosts).toEqual([]);

		expect(config.cacheClearToken).toBe("");
		expect(config.wsKeepaliveMs).toBe(30_000);
		expect(config.redisUrl).toBe("redis://localhost:6379");
		expect(config.bullmqPrefix).toBe("tm");
		expect(config.domainCrawlEnabled).toBe(true);
		expect(config.workerConcurrency).toBe(2);
		expect(config.workerRateLimitPerSec).toBe(1);
		expect(config.crawlMaxCdxPages).toBe(50);
		expect(config.outboundProxyUrls).toEqual([]);
		expect(config.outboundProxyUsername).toBe("");
		expect(config.outboundProxyPassword).toBe("");
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

	it("reads worker integer env vars", () => {
		process.env.WORKER_CONCURRENCY = "5";
		process.env.WORKER_RATE_LIMIT_PER_SEC = "2";
		process.env.CRAWL_MAX_CDX_PAGES = "100";

		const config = loadConfig();

		expect(config.workerConcurrency).toBe(5);
		expect(config.workerRateLimitPerSec).toBe(2);
		expect(config.crawlMaxCdxPages).toBe(100);
	});

	it("CDX_CACHE_ENABLED defaults to true when unset or empty", () => {
		delete process.env.CDX_CACHE_ENABLED;
		expect(loadConfig().cdxCacheEnabled).toBe(true);

		process.env.CDX_CACHE_ENABLED = "";
		expect(loadConfig().cdxCacheEnabled).toBe(true);
	});

	it("CDX_CACHE_ENABLED=false (case-insensitive) disables the cache", () => {
		process.env.CDX_CACHE_ENABLED = "false";
		expect(loadConfig().cdxCacheEnabled).toBe(false);

		process.env.CDX_CACHE_ENABLED = "FALSE";
		expect(loadConfig().cdxCacheEnabled).toBe(false);

		process.env.CDX_CACHE_ENABLED = "False";
		expect(loadConfig().cdxCacheEnabled).toBe(false);
	});

	it("CDX_CACHE_ENABLED=true keeps the cache enabled", () => {
		process.env.CDX_CACHE_ENABLED = "true";
		expect(loadConfig().cdxCacheEnabled).toBe(true);
	});

	it("CRAWL_WINDOW_DAYS defaults to 30 when unset", () => {
		delete process.env.CRAWL_WINDOW_DAYS;
		expect(loadConfig().crawlWindowDays).toBe(30);
	});

	it("CRAWL_WINDOW_DAYS=7 parses correctly", () => {
		process.env.CRAWL_WINDOW_DAYS = "7";
		expect(loadConfig().crawlWindowDays).toBe(7);
	});

	it("CRAWL_WINDOW_DAYS=0 is rejected (below min 1)", () => {
		process.env.CRAWL_WINDOW_DAYS = "0";
		expect(() => loadConfig()).toThrow(/CRAWL_WINDOW_DAYS/);
	});

	it("CRAWL_WINDOW_DAYS=3651 is rejected (above max 3650)", () => {
		process.env.CRAWL_WINDOW_DAYS = "3651";
		expect(() => loadConfig()).toThrow(/CRAWL_WINDOW_DAYS/);
	});

	it("CRAWL_WINDOW_DAYS non-integer is rejected", () => {
		process.env.CRAWL_WINDOW_DAYS = "1.5";
		expect(() => loadConfig()).toThrow(/CRAWL_WINDOW_DAYS/);

		process.env.CRAWL_WINDOW_DAYS = "abc";
		expect(() => loadConfig()).toThrow(/CRAWL_WINDOW_DAYS/);
	});

	it("CRAWL_MAX_CHUNK_FANOUT defaults to 1000 when unset", () => {
		delete process.env.CRAWL_MAX_CHUNK_FANOUT;
		expect(loadConfig().crawlMaxChunkFanout).toBe(1000);
	});

	it("CRAWL_MAX_CHUNK_FANOUT=500 parses correctly", () => {
		process.env.CRAWL_MAX_CHUNK_FANOUT = "500";
		expect(loadConfig().crawlMaxChunkFanout).toBe(500);
	});

	it("CRAWL_MAX_CHUNK_FANOUT=0 is rejected (below min 1)", () => {
		process.env.CRAWL_MAX_CHUNK_FANOUT = "0";
		expect(() => loadConfig()).toThrow(/CRAWL_MAX_CHUNK_FANOUT/);
	});

	it("CRAWL_MAX_CHUNK_FANOUT=10001 is rejected (above max 10000)", () => {
		process.env.CRAWL_MAX_CHUNK_FANOUT = "10001";
		expect(() => loadConfig()).toThrow(/CRAWL_MAX_CHUNK_FANOUT/);
	});

	it("CRAWL_MAX_CHUNK_FANOUT non-integer is rejected", () => {
		process.env.CRAWL_MAX_CHUNK_FANOUT = "1.5";
		expect(() => loadConfig()).toThrow(/CRAWL_MAX_CHUNK_FANOUT/);
	});

	it("reads outbound proxy env vars", () => {
		process.env.OUTBOUND_PROXY_URLS = "http://proxymesh.example.com:31280";
		process.env.OUTBOUND_PROXY_USERNAME = "user";
		process.env.OUTBOUND_PROXY_PASSWORD = "secret";

		const config = loadConfig();

		expect(config.outboundProxyUrls).toEqual(["http://proxymesh.example.com:31280"]);
		expect(config.outboundProxyUsername).toBe("user");
		expect(config.outboundProxyPassword).toBe("secret");
	});
});
