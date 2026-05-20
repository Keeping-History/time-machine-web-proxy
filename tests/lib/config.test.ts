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
		delete process.env.OUTBOUND_PROXY_URLS;
		delete process.env.OUTBOUND_PROXY_CHOOSER;
		delete process.env.OUTBOUND_PROXY_USERNAME;
		delete process.env.OUTBOUND_PROXY_PASSWORD;
		delete process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS;

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
		expect(config.outboundProxyUrls).toEqual([]);
		expect(config.outboundProxyChooser).toBe("sequential");
		expect(config.outboundProxyUsername).toBe("");
		expect(config.outboundProxyPassword).toBe("");
		expect(config.outboundProxyCooldownMs).toBe(60_000);
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

	it("reads a single outbound proxy URL from OUTBOUND_PROXY_URLS", () => {
		process.env.OUTBOUND_PROXY_URLS = "http://proxymesh.example.com:31280";
		process.env.OUTBOUND_PROXY_USERNAME = "user";
		process.env.OUTBOUND_PROXY_PASSWORD = "secret";

		const config = loadConfig();

		expect(config.outboundProxyUrls).toEqual(["http://proxymesh.example.com:31280"]);
		expect(config.outboundProxyUsername).toBe("user");
		expect(config.outboundProxyPassword).toBe("secret");
	});

	it("parses OUTBOUND_PROXY_URLS as a CSV, trimming whitespace and dropping empties", () => {
		process.env.OUTBOUND_PROXY_URLS =
			"http://a.example.com:31280, http://b.example.com:31280 ,,http://c.example.com:31280";

		const config = loadConfig();

		expect(config.outboundProxyUrls).toEqual([
			"http://a.example.com:31280",
			"http://b.example.com:31280",
			"http://c.example.com:31280",
		]);
	});

	it("defaults outboundProxyChooser to 'sequential' when unset", () => {
		delete process.env.OUTBOUND_PROXY_CHOOSER;
		expect(loadConfig().outboundProxyChooser).toBe("sequential");
	});

	it("parses OUTBOUND_PROXY_CHOOSER case-insensitively", () => {
		process.env.OUTBOUND_PROXY_CHOOSER = "Sequential";
		expect(loadConfig().outboundProxyChooser).toBe("sequential");

		process.env.OUTBOUND_PROXY_CHOOSER = "RANDOM";
		expect(loadConfig().outboundProxyChooser).toBe("random");

		process.env.OUTBOUND_PROXY_CHOOSER = "random";
		expect(loadConfig().outboundProxyChooser).toBe("random");
	});

	it("throws on unknown OUTBOUND_PROXY_CHOOSER value", () => {
		process.env.OUTBOUND_PROXY_CHOOSER = "roundrobin";
		expect(() => loadConfig()).toThrow(/OUTBOUND_PROXY_CHOOSER must be "sequential" or "random"/);
	});

	it("defaults outboundProxyCooldownMs to 60_000 when unset", () => {
		delete process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS;
		expect(loadConfig().outboundProxyCooldownMs).toBe(60_000);
	});

	it("parses OUTBOUND_PROXY_COOLDOWN_SECONDS as seconds and converts to ms", () => {
		process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS = "30";
		expect(loadConfig().outboundProxyCooldownMs).toBe(30_000);

		process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS = "120";
		expect(loadConfig().outboundProxyCooldownMs).toBe(120_000);
	});

	it("accepts 0 as a valid OUTBOUND_PROXY_COOLDOWN_SECONDS (disables cooldown)", () => {
		process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS = "0";
		expect(loadConfig().outboundProxyCooldownMs).toBe(0);
	});

	it("throws on negative OUTBOUND_PROXY_COOLDOWN_SECONDS", () => {
		process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS = "-5";
		expect(() => loadConfig()).toThrow(/non-negative/);
	});

	it("throws on non-numeric OUTBOUND_PROXY_COOLDOWN_SECONDS", () => {
		process.env.OUTBOUND_PROXY_COOLDOWN_SECONDS = "abc";
		expect(() => loadConfig()).toThrow(/non-negative/);
	});
});
