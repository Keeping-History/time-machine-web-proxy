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
		delete process.env.URL_PREFIX;
		delete process.env.LISTENER;
		delete process.env.CACHE_DIR;
		delete process.env.CACHE_ENABLED;
		delete process.env.CORS_ORIGIN;
		delete process.env.ARCHIVE_RATE_PER_SEC;
		delete process.env.ARCHIVE_BURST;
		delete process.env.ARCHIVE_MAX_RETRIES;
		delete process.env.ARCHIVE_MAX_CONCURRENT;
		delete process.env.WHITELIST_HOSTS;
		delete process.env.PROXY_PREFIX;
		delete process.env.PROXY_BASE_URL;
		delete process.env.CACHE_CLEAR_TOKEN;
		delete process.env.WS_KEEPALIVE_MS;

		const config = loadConfig();

		expect(config.port).toBe(8765);
		expect(config.defaultTime).toBe("19980101000000");
		expect(config.archivePrefix).toBe("https://web.archive.org/web");
		expect(config.hostname).toBe("0.0.0.0");
		expect(config.cacheDir).toBe("/app/cache");
		expect(config.cacheEnabled).toBe(true);
		expect(config.archiveRatePerSec).toBe(2);
		expect(config.archiveBurst).toBe(5);
		expect(config.archiveMaxRetries).toBe(3);
		expect(config.archiveMaxConcurrent).toBe(10);
		expect(config.whitelistHosts).toBe("*");
		expect(config.proxyPrefix).toBe("");
		expect(config.cacheClearToken).toBe("");
		expect(config.wsKeepaliveMs).toBe(30_000);
	});

	it("reads values from env vars", () => {
		process.env.TIMEMACHINE_PORT = "9000";
		process.env.ARCHIVE_TIME = "20000101000000";
		process.env.CACHE_ENABLED = "false";
		process.env.CORS_ORIGIN = "https://example.com,https://other.com";
		process.env.ARCHIVE_RATE_PER_SEC = "5";
		process.env.WS_KEEPALIVE_MS = "60000";
		process.env.PROXY_BASE_URL = "https://proxy.example.com";

		const config = loadConfig();

		expect(config.port).toBe(9000);
		expect(config.defaultTime).toBe("20000101000000");
		expect(config.cacheEnabled).toBe(false);
		expect(config.allowedOrigins).toEqual(["https://example.com", "https://other.com"]);
		expect(config.archiveRatePerSec).toBe(5);
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
});
