import { loadConfig } from "../../src/lib/config";

/**
 * Helper: set env vars, call loadConfig(), restore originals.
 * Only the keys provided are mutated; all others retain their process.env value.
 */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const originals: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(overrides)) {
		originals[k] = process.env[k];
		if (v === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = v;
		}
	}
	try {
		fn();
	} finally {
		for (const [k, v] of Object.entries(originals)) {
			if (v === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = v;
			}
		}
	}
}

// ─── defaults ────────────────────────────────────────────────────────────────

describe("loadConfig() — new env var defaults", () => {
	it("DIRECT_FETCH_ENABLED defaults to true", () => {
		withEnv({ DIRECT_FETCH_ENABLED: undefined }, () => {
			expect(loadConfig().directFetchEnabled).toBe(true);
		});
	});

	it("DIRECT_FETCH_MAX_CONCURRENT defaults to 10", () => {
		withEnv({ DIRECT_FETCH_MAX_CONCURRENT: undefined }, () => {
			expect(loadConfig().directFetchMaxConcurrent).toBe(10);
		});
	});

	it("DIRECT_FETCH_TIMEOUT_MS defaults to 30000", () => {
		withEnv({ DIRECT_FETCH_TIMEOUT_MS: undefined }, () => {
			expect(loadConfig().directFetchTimeoutMs).toBe(30_000);
		});
	});

	it("DIRECT_FETCH_RATE_PER_SEC defaults to 20", () => {
		withEnv({ DIRECT_FETCH_RATE_PER_SEC: undefined }, () => {
			expect(loadConfig().directFetchRatePerSec).toBe(20);
		});
	});

	it("DIRECT_FETCH_BURST defaults to 30", () => {
		withEnv({ DIRECT_FETCH_BURST: undefined }, () => {
			expect(loadConfig().directFetchBurst).toBe(30);
		});
	});

	it("PREWARM_ENABLED defaults to true", () => {
		withEnv({ PREWARM_ENABLED: undefined }, () => {
			expect(loadConfig().prewarmEnabled).toBe(true);
		});
	});

	it("PREWARM_MAX_ASSETS_PER_PAGE defaults to 100", () => {
		withEnv({ PREWARM_MAX_ASSETS_PER_PAGE: undefined }, () => {
			expect(loadConfig().prewarmMaxAssetsPerPage).toBe(100);
		});
	});

	it("NOT_FOUND_TTL_DAYS defaults to 30", () => {
		withEnv({ NOT_FOUND_TTL_DAYS: undefined }, () => {
			expect(loadConfig().notFoundTtlDays).toBe(30);
		});
	});

	it("DIRECT_FETCH_POOL_CONNECTIONS defaults to 5", () => {
		withEnv({ DIRECT_FETCH_POOL_CONNECTIONS: undefined }, () => {
			expect(loadConfig().directFetchPoolConnections).toBe(5);
		});
	});

	it("DIRECT_FETCH_POOL_KEEPALIVE_MS defaults to 30000", () => {
		withEnv({ DIRECT_FETCH_POOL_KEEPALIVE_MS: undefined }, () => {
			expect(loadConfig().directFetchPoolKeepaliveMs).toBe(30_000);
		});
	});

	it("DIRECT_FETCH_POOL_MAX_STREAMS defaults to 10", () => {
		withEnv({ DIRECT_FETCH_POOL_MAX_STREAMS: undefined }, () => {
			expect(loadConfig().directFetchPoolMaxConcurrentStreams).toBe(10);
		});
	});

	it("DIRECT_FETCH_HTTP2_ENABLED defaults to true", () => {
		withEnv({ DIRECT_FETCH_HTTP2_ENABLED: undefined }, () => {
			expect(loadConfig().directFetchHttp2Enabled).toBe(true);
		});
	});
});

// ─── valid values ─────────────────────────────────────────────────────────────

describe("loadConfig() — valid values accepted", () => {
	it("DIRECT_FETCH_ENABLED=false parses to false", () => {
		withEnv({ DIRECT_FETCH_ENABLED: "false" }, () => {
			expect(loadConfig().directFetchEnabled).toBe(false);
		});
	});

	it("DIRECT_FETCH_ENABLED=true parses to true", () => {
		withEnv({ DIRECT_FETCH_ENABLED: "true" }, () => {
			expect(loadConfig().directFetchEnabled).toBe(true);
		});
	});

	it("DIRECT_FETCH_MAX_CONCURRENT=1 (min boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_MAX_CONCURRENT: "1" }, () => {
			expect(loadConfig().directFetchMaxConcurrent).toBe(1);
		});
	});

	it("DIRECT_FETCH_MAX_CONCURRENT=50 (max boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_MAX_CONCURRENT: "50" }, () => {
			expect(loadConfig().directFetchMaxConcurrent).toBe(50);
		});
	});

	it("DIRECT_FETCH_TIMEOUT_MS=1000 (min boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_TIMEOUT_MS: "1000" }, () => {
			expect(loadConfig().directFetchTimeoutMs).toBe(1_000);
		});
	});

	it("DIRECT_FETCH_TIMEOUT_MS=60000 (max boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_TIMEOUT_MS: "60000" }, () => {
			expect(loadConfig().directFetchTimeoutMs).toBe(60_000);
		});
	});

	it("DIRECT_FETCH_RATE_PER_SEC=1 (min boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_RATE_PER_SEC: "1" }, () => {
			expect(loadConfig().directFetchRatePerSec).toBe(1);
		});
	});

	it("DIRECT_FETCH_RATE_PER_SEC=100 (max boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_RATE_PER_SEC: "100" }, () => {
			expect(loadConfig().directFetchRatePerSec).toBe(100);
		});
	});

	it("DIRECT_FETCH_BURST=1 (min boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_BURST: "1" }, () => {
			expect(loadConfig().directFetchBurst).toBe(1);
		});
	});

	it("DIRECT_FETCH_BURST=200 (max boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_BURST: "200" }, () => {
			expect(loadConfig().directFetchBurst).toBe(200);
		});
	});

	it("PREWARM_ENABLED=false parses to false", () => {
		withEnv({ PREWARM_ENABLED: "false" }, () => {
			expect(loadConfig().prewarmEnabled).toBe(false);
		});
	});

	it("PREWARM_MAX_ASSETS_PER_PAGE=0 (min boundary) is accepted", () => {
		withEnv({ PREWARM_MAX_ASSETS_PER_PAGE: "0" }, () => {
			expect(loadConfig().prewarmMaxAssetsPerPage).toBe(0);
		});
	});

	it("PREWARM_MAX_ASSETS_PER_PAGE=500 (max boundary) is accepted", () => {
		withEnv({ PREWARM_MAX_ASSETS_PER_PAGE: "500" }, () => {
			expect(loadConfig().prewarmMaxAssetsPerPage).toBe(500);
		});
	});

	it("NOT_FOUND_TTL_DAYS=1 (min boundary) is accepted", () => {
		withEnv({ NOT_FOUND_TTL_DAYS: "1" }, () => {
			expect(loadConfig().notFoundTtlDays).toBe(1);
		});
	});

	it("NOT_FOUND_TTL_DAYS=3650 (max boundary) is accepted", () => {
		withEnv({ NOT_FOUND_TTL_DAYS: "3650" }, () => {
			expect(loadConfig().notFoundTtlDays).toBe(3650);
		});
	});

	it("DIRECT_FETCH_POOL_CONNECTIONS=1 (min boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_POOL_CONNECTIONS: "1" }, () => {
			expect(loadConfig().directFetchPoolConnections).toBe(1);
		});
	});

	it("DIRECT_FETCH_POOL_CONNECTIONS=50 (max boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_POOL_CONNECTIONS: "50" }, () => {
			expect(loadConfig().directFetchPoolConnections).toBe(50);
		});
	});

	it("DIRECT_FETCH_POOL_KEEPALIVE_MS=1000 (min boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_POOL_KEEPALIVE_MS: "1000" }, () => {
			expect(loadConfig().directFetchPoolKeepaliveMs).toBe(1_000);
		});
	});

	it("DIRECT_FETCH_POOL_KEEPALIVE_MS=300000 (max boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_POOL_KEEPALIVE_MS: "300000" }, () => {
			expect(loadConfig().directFetchPoolKeepaliveMs).toBe(300_000);
		});
	});

	it("DIRECT_FETCH_POOL_MAX_STREAMS=1 (min boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_POOL_MAX_STREAMS: "1" }, () => {
			expect(loadConfig().directFetchPoolMaxConcurrentStreams).toBe(1);
		});
	});

	it("DIRECT_FETCH_POOL_MAX_STREAMS=100 (max boundary) is accepted", () => {
		withEnv({ DIRECT_FETCH_POOL_MAX_STREAMS: "100" }, () => {
			expect(loadConfig().directFetchPoolMaxConcurrentStreams).toBe(100);
		});
	});

	it("DIRECT_FETCH_HTTP2_ENABLED=false parses to false", () => {
		withEnv({ DIRECT_FETCH_HTTP2_ENABLED: "false" }, () => {
			expect(loadConfig().directFetchHttp2Enabled).toBe(false);
		});
	});

	it("DIRECT_FETCH_HTTP2_ENABLED=true parses to true", () => {
		withEnv({ DIRECT_FETCH_HTTP2_ENABLED: "true" }, () => {
			expect(loadConfig().directFetchHttp2Enabled).toBe(true);
		});
	});
});

// ─── out-of-range / invalid values rejected ──────────────────────────────────

describe("loadConfig() — out-of-range values rejected", () => {
	it("DIRECT_FETCH_ENABLED=yes throws an informative error", () => {
		withEnv({ DIRECT_FETCH_ENABLED: "yes" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_ENABLED/);
		});
	});

	it("DIRECT_FETCH_MAX_CONCURRENT=0 (below min) throws", () => {
		withEnv({ DIRECT_FETCH_MAX_CONCURRENT: "0" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_MAX_CONCURRENT/);
		});
	});

	it("DIRECT_FETCH_MAX_CONCURRENT=51 (above max) throws", () => {
		withEnv({ DIRECT_FETCH_MAX_CONCURRENT: "51" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_MAX_CONCURRENT/);
		});
	});

	it("DIRECT_FETCH_TIMEOUT_MS=999 (below min) throws", () => {
		withEnv({ DIRECT_FETCH_TIMEOUT_MS: "999" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_TIMEOUT_MS/);
		});
	});

	it("DIRECT_FETCH_TIMEOUT_MS=60001 (above max) throws", () => {
		withEnv({ DIRECT_FETCH_TIMEOUT_MS: "60001" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_TIMEOUT_MS/);
		});
	});

	it("DIRECT_FETCH_RATE_PER_SEC=0 (below min) throws", () => {
		withEnv({ DIRECT_FETCH_RATE_PER_SEC: "0" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_RATE_PER_SEC/);
		});
	});

	it("DIRECT_FETCH_RATE_PER_SEC=101 (above max) throws", () => {
		withEnv({ DIRECT_FETCH_RATE_PER_SEC: "101" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_RATE_PER_SEC/);
		});
	});

	it("DIRECT_FETCH_BURST=0 (below min) throws", () => {
		withEnv({ DIRECT_FETCH_BURST: "0" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_BURST/);
		});
	});

	it("DIRECT_FETCH_BURST=201 (above max) throws", () => {
		withEnv({ DIRECT_FETCH_BURST: "201" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_BURST/);
		});
	});

	it("PREWARM_ENABLED=1 throws an informative error", () => {
		withEnv({ PREWARM_ENABLED: "1" }, () => {
			expect(() => loadConfig()).toThrow(/PREWARM_ENABLED/);
		});
	});

	it("PREWARM_MAX_ASSETS_PER_PAGE=-1 (below min) throws", () => {
		withEnv({ PREWARM_MAX_ASSETS_PER_PAGE: "-1" }, () => {
			expect(() => loadConfig()).toThrow(/PREWARM_MAX_ASSETS_PER_PAGE/);
		});
	});

	it("PREWARM_MAX_ASSETS_PER_PAGE=501 (above max) throws", () => {
		withEnv({ PREWARM_MAX_ASSETS_PER_PAGE: "501" }, () => {
			expect(() => loadConfig()).toThrow(/PREWARM_MAX_ASSETS_PER_PAGE/);
		});
	});

	it("NOT_FOUND_TTL_DAYS=0 (below min) throws", () => {
		withEnv({ NOT_FOUND_TTL_DAYS: "0" }, () => {
			expect(() => loadConfig()).toThrow(/NOT_FOUND_TTL_DAYS/);
		});
	});

	it("NOT_FOUND_TTL_DAYS=3651 (above max) throws", () => {
		withEnv({ NOT_FOUND_TTL_DAYS: "3651" }, () => {
			expect(() => loadConfig()).toThrow(/NOT_FOUND_TTL_DAYS/);
		});
	});

	it("NOT_FOUND_TTL_DAYS=abc (non-integer) throws", () => {
		withEnv({ NOT_FOUND_TTL_DAYS: "abc" }, () => {
			expect(() => loadConfig()).toThrow(/NOT_FOUND_TTL_DAYS/);
		});
	});

	it("DIRECT_FETCH_MAX_CONCURRENT=10.5 (float) throws", () => {
		withEnv({ DIRECT_FETCH_MAX_CONCURRENT: "10.5" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_MAX_CONCURRENT/);
		});
	});

	it("DIRECT_FETCH_POOL_CONNECTIONS=0 (below min) throws", () => {
		withEnv({ DIRECT_FETCH_POOL_CONNECTIONS: "0" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_POOL_CONNECTIONS/);
		});
	});

	it("DIRECT_FETCH_POOL_CONNECTIONS=51 (above max) throws", () => {
		withEnv({ DIRECT_FETCH_POOL_CONNECTIONS: "51" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_POOL_CONNECTIONS/);
		});
	});

	it("DIRECT_FETCH_POOL_KEEPALIVE_MS=999 (below min) throws", () => {
		withEnv({ DIRECT_FETCH_POOL_KEEPALIVE_MS: "999" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_POOL_KEEPALIVE_MS/);
		});
	});

	it("DIRECT_FETCH_POOL_KEEPALIVE_MS=300001 (above max) throws", () => {
		withEnv({ DIRECT_FETCH_POOL_KEEPALIVE_MS: "300001" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_POOL_KEEPALIVE_MS/);
		});
	});

	it("DIRECT_FETCH_POOL_MAX_STREAMS=0 (below min) throws", () => {
		withEnv({ DIRECT_FETCH_POOL_MAX_STREAMS: "0" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_POOL_MAX_STREAMS/);
		});
	});

	it("DIRECT_FETCH_POOL_MAX_STREAMS=101 (above max) throws", () => {
		withEnv({ DIRECT_FETCH_POOL_MAX_STREAMS: "101" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_POOL_MAX_STREAMS/);
		});
	});

	it("DIRECT_FETCH_HTTP2_ENABLED=yes throws an informative error", () => {
		withEnv({ DIRECT_FETCH_HTTP2_ENABLED: "yes" }, () => {
			expect(() => loadConfig()).toThrow(/DIRECT_FETCH_HTTP2_ENABLED/);
		});
	});
});
