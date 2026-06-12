import { loadConfig, validateConfig } from "../../src/lib/config";

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
		delete process.env.CRAWL_MAX_DEPTH;
		delete process.env.CRAWL_MAX_PAGES;
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
		expect(config.crawlMaxDepth).toBe(3);
		expect(config.crawlMaxPages).toBe(1000);
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
		process.env.CRAWL_MAX_DEPTH = "6";

		const config = loadConfig();

		expect(config.workerConcurrency).toBe(5);
		expect(config.workerRateLimitPerSec).toBe(2);
		expect(config.crawlMaxDepth).toBe(6);
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

	it("CRAWL_MAX_DEPTH defaults to 3 when unset", () => {
		delete process.env.CRAWL_MAX_DEPTH;
		expect(loadConfig().crawlMaxDepth).toBe(3);
	});

	it("CRAWL_MAX_DEPTH=6 parses correctly", () => {
		process.env.CRAWL_MAX_DEPTH = "6";
		expect(loadConfig().crawlMaxDepth).toBe(6);
	});

	it("CRAWL_MAX_DEPTH=0 is rejected (below min 1)", () => {
		process.env.CRAWL_MAX_DEPTH = "0";
		expect(() => loadConfig()).toThrow(/CRAWL_MAX_DEPTH/);
	});

	it("CRAWL_MAX_DEPTH=21 is rejected (above max 20)", () => {
		process.env.CRAWL_MAX_DEPTH = "21";
		expect(() => loadConfig()).toThrow(/CRAWL_MAX_DEPTH/);
	});

	it("CRAWL_MAX_PAGES defaults to 1000 when unset", () => {
		delete process.env.CRAWL_MAX_PAGES;
		expect(loadConfig().crawlMaxPages).toBe(1000);
	});

	it("CRAWL_MAX_PAGES=25000 parses correctly", () => {
		process.env.CRAWL_MAX_PAGES = "25000";
		expect(loadConfig().crawlMaxPages).toBe(25000);
	});

	it("CRAWL_MAX_PAGES=0 is rejected (below min 1)", () => {
		process.env.CRAWL_MAX_PAGES = "0";
		expect(() => loadConfig()).toThrow(/CRAWL_MAX_PAGES/);
	});

	it("CRAWL_MAX_PAGES non-integer is rejected", () => {
		process.env.CRAWL_MAX_PAGES = "1.5";
		expect(() => loadConfig()).toThrow(/CRAWL_MAX_PAGES/);
	});

	it("LOCK_TIME defaults to false when unset", () => {
		delete process.env.LOCK_TIME;
		expect(loadConfig().lockTime).toBe(false);
	});

	it("LOCK_TIME=true enables lock time", () => {
		process.env.LOCK_TIME = "true";
		expect(loadConfig().lockTime).toBe(true);
	});

	it("LOCK_TIME=1 throws (only 'true'/'false' accepted)", () => {
		process.env.LOCK_TIME = "1";
		expect(() => loadConfig()).toThrow(/LOCK_TIME/);
	});

	it("LOCK_TIME=yes throws (only 'true'/'false' accepted)", () => {
		process.env.LOCK_TIME = "yes";
		expect(() => loadConfig()).toThrow(/LOCK_TIME/);
	});

	it("OUTBOUND_PROXY_COOLDOWN_SECONDS defaults to 60000ms when unset", () => {
		delete process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS;
		expect(loadConfig().outboundProxyCooldownMs).toBe(60_000);
	});

	it("OUTBOUND_PROXY_COOLDOWN_SECONDS=30 parses to 30000ms", () => {
		process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS = "30";
		expect(loadConfig().outboundProxyCooldownMs).toBe(30_000);
	});

	it("OUTBOUND_PROXY_COOLDOWN_SECONDS=0 is valid (disables cooldown)", () => {
		process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS = "0";
		expect(loadConfig().outboundProxyCooldownMs).toBe(0);
	});

	it("OUTBOUND_PROXY_COOLDOWN_SECONDS=-1 throws (negative not allowed)", () => {
		process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS = "-1";
		expect(() => loadConfig()).toThrow(/OUTBOUND_PROXY_COOLDOWN_SECONDS/);
	});

	it("OUTBOUND_PROXY_COOLDOWN_SECONDS=abc throws (non-numeric)", () => {
		process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS = "abc";
		expect(() => loadConfig()).toThrow(/OUTBOUND_PROXY_COOLDOWN_SECONDS/);
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

describe("validateConfig", () => {
	it("does not warn when cacheClearToken is empty (feature disabled)", () => {
		const logger = { warn: jest.fn() };
		const config = loadConfig();
		validateConfig({ ...config, cacheClearToken: "" }, logger);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("does not warn when cacheClearToken meets the minimum length", () => {
		const logger = { warn: jest.fn() };
		const config = loadConfig();
		validateConfig({ ...config, cacheClearToken: "a".repeat(16) }, logger);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("does not warn when cacheClearToken exceeds the minimum length", () => {
		const logger = { warn: jest.fn() };
		const config = loadConfig();
		validateConfig({ ...config, cacheClearToken: "a".repeat(32) }, logger);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("warns when cacheClearToken is set but shorter than 16 characters", () => {
		const logger = { warn: jest.fn() };
		const config = loadConfig();
		validateConfig({ ...config, cacheClearToken: "short" }, logger);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn.mock.calls[0][0]).toMatch(/CACHE_CLEAR_TOKEN/);
		expect(logger.warn.mock.calls[0][0]).toMatch(/16/);
	});

	it("does not throw even for a very short token — warn only", () => {
		const logger = { warn: jest.fn() };
		const config = loadConfig();
		expect(() => validateConfig({ ...config, cacheClearToken: "x" }, logger)).not.toThrow();
	});
});
