// Tests for src/clients/wayback-direct-client.ts
//
// globalThis.fetch is stubbed per-test so we never make real network calls.
// The token-bucket test uses jest fake timers to control Date.now() and
// setTimeout without real wall-clock delay.

import type pino from "pino";
import { WaybackDirectClient } from "../../src/clients/wayback-direct-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): pino.Logger {
	return {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	} as unknown as pino.Logger;
}

/** Build a minimal Response-like object that satisfies our fetch usage. */
function makeFetchResponse(opts: {
	status: number;
	url?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
}): Response {
	const headersMap = new Map(Object.entries(opts.headers ?? {}));
	return {
		status: opts.status,
		ok: opts.status >= 200 && opts.status < 300,
		url: opts.url ?? "",
		headers: {
			get: (name: string) => headersMap.get(name.toLowerCase()) ?? null,
		},
		arrayBuffer: async () => {
			const data = opts.body ?? "";
			const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
			// Copy into a fresh ArrayBuffer to avoid the Node.js Buffer pool
			// slab issue (buf.buffer is an 8 KiB pool, not just the string bytes).
			const ab = new ArrayBuffer(bytes.byteLength);
			new Uint8Array(ab).set(bytes);
			return ab;
		},
		text: async () => (typeof opts.body === "string" ? opts.body : ""),
	} as unknown as Response;
}

function makeClient(config?: ConstructorParameters<typeof WaybackDirectClient>[0]) {
	return new WaybackDirectClient({ logger: makeLogger(), ...config });
}

// ---------------------------------------------------------------------------
// fetchAtResolvedTime
// ---------------------------------------------------------------------------

describe("WaybackDirectClient.fetchAtResolvedTime", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns ok with body and contentType on HTTP 200", async () => {
		const bodyText = "<html>hello</html>";
		globalThis.fetch = jest.fn().mockResolvedValue(
			makeFetchResponse({
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
				body: bodyText,
			}),
		);
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("ok");
		expect(result.body?.toString()).toBe(bodyText);
		expect(result.contentType).toBe("text/html; charset=utf-8");
	});

	it("constructs the correct id_ URL", async () => {
		globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse({ status: 200, body: "" }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtResolvedTime("http://example.com/page", "20200615120000");
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://web.archive.org/web/20200615120000id_/http://example.com/page",
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("returns not_found on HTTP 404", async () => {
		globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse({ status: 404 }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("not_found");
	});

	it("returns fallback on 3xx (redirect: manual)", async () => {
		for (const status of [301, 302, 307, 308]) {
			globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse({ status }));
			const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
			const result = await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
			expect(result.outcome).toBe("fallback");
			expect(result.reason).toMatch(/^redirect-/);
		}
	});

	it("returns fallback on 5xx", async () => {
		globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse({ status: 503 }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("fallback");
		expect(result.reason).toBe("http-503");
	});

	it("returns fallback with reason on fetch error (timeout / network)", async () => {
		globalThis.fetch = jest.fn().mockRejectedValue(new Error("AbortError: timeout"));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("fallback");
		expect(result.reason).toContain("timeout");
	});

	it("returns fallback with bad-timestamp for a non-14-digit ts", async () => {
		globalThis.fetch = jest.fn();
		const client = makeClient();
		const result = await client.fetchAtResolvedTime("http://example.com/", "2020");
		expect(result).toEqual({ outcome: "fallback", reason: "bad-timestamp" });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("returns fallback with bad-timestamp for empty string", async () => {
		globalThis.fetch = jest.fn();
		const client = makeClient();
		const result = await client.fetchAtResolvedTime("http://example.com/", "");
		expect(result).toEqual({ outcome: "fallback", reason: "bad-timestamp" });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("uses redirect: 'manual' in the fetch call", async () => {
		globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse({ status: 200, body: "" }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		const [, opts] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
		expect(opts.redirect).toBe("manual");
	});

	it("passes AbortSignal.timeout to fetch (respects timeoutMs)", async () => {
		globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse({ status: 200, body: "" }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000, timeoutMs: 5000 });
		await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		const [, opts] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
		expect(opts.signal).toBeDefined();
	});

	it("logs the archiveUrl and HTTP status at info level on successful response", async () => {
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 200, body: "ok" }));
		const logger = makeLogger();
		const client = new WaybackDirectClient({ logger, ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({
				archiveUrl: expect.stringContaining("20200101000000id_"),
				status: 200,
			}),
			expect.stringContaining("response"),
		);
	});

	it("logs network errors at warn level (not debug)", async () => {
		const networkErr = new Error("ETIMEDOUT");
		globalThis.fetch = jest.fn().mockRejectedValue(networkErr);
		const logger = makeLogger();
		const client = new WaybackDirectClient({ logger, ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ archiveUrl: expect.stringContaining("id_") }),
			expect.stringContaining("fetch error"),
		);
		// Must NOT be debug-only for network errors
		expect(logger.debug).not.toHaveBeenCalledWith(
			expect.objectContaining({ archiveUrl: expect.anything() }),
			expect.stringContaining("fetch error"),
		);
	});
});

// ---------------------------------------------------------------------------
// fetchAtRequestedTime
// ---------------------------------------------------------------------------

describe("WaybackDirectClient.fetchAtRequestedTime", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns ok with resolvedTime parsed from the final response URL", async () => {
		const finalUrl = "https://web.archive.org/web/20200615120000id_/http://example.com/page";
		globalThis.fetch = jest.fn().mockResolvedValue(
			makeFetchResponse({
				status: 200,
				url: finalUrl,
				headers: { "content-type": "text/html" },
				body: "<html>ok</html>",
			}),
		);
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtRequestedTime("http://example.com/page", "20200101000000");
		expect(result.outcome).toBe("ok");
		expect(result.resolvedTime).toBe("20200615120000");
		expect(result.contentType).toBe("text/html");
	});

	it("constructs the correct im_ URL", async () => {
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 200, url: "", body: "" }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://web.archive.org/web/20200101000000im_/http://example.com/",
			expect.objectContaining({ redirect: "follow" }),
		);
	});

	it("returns not_found on HTTP 404", async () => {
		globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse({ status: 404 }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("not_found");
	});

	it("returns fallback on 5xx", async () => {
		globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse({ status: 500 }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("fallback");
		expect(result.reason).toBe("http-500");
	});

	it("returns fallback on fetch error", async () => {
		globalThis.fetch = jest.fn().mockRejectedValue(new Error("network error"));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("fallback");
		expect(result.reason).toContain("network");
	});

	it("returns fallback with bad-timestamp for non-14-digit ts", async () => {
		globalThis.fetch = jest.fn();
		const client = makeClient();
		const result = await client.fetchAtRequestedTime("http://example.com/", "abc");
		expect(result).toEqual({ outcome: "fallback", reason: "bad-timestamp" });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("handles missing resolvedTime (final URL doesn't contain id_ pattern)", async () => {
		globalThis.fetch = jest.fn().mockResolvedValue(
			makeFetchResponse({
				status: 200,
				// URL without the id_ pattern (e.g. redirect to non-wayback host)
				url: "https://example.com/page",
				body: "<html>hello</html>",
			}),
		);
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("ok");
		expect(result.resolvedTime).toBeUndefined();
	});

	it("follows redirects (redirect: 'follow')", async () => {
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 200, url: "", body: "" }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		const [, opts] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
		expect(opts.redirect).toBe("follow");
	});

	it("logs the archiveUrl and HTTP status at info level on successful response", async () => {
		globalThis.fetch = jest.fn().mockResolvedValue(
			makeFetchResponse({ status: 200, url: "https://web.archive.org/web/20200101120000id_/http://example.com/", body: "ok" }),
		);
		const logger = makeLogger();
		const client = new WaybackDirectClient({ logger, ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({
				archiveUrl: expect.stringContaining("20200101000000im_"),
				status: 200,
			}),
			expect.stringContaining("response"),
		);
	});

	it("logs network errors at warn level (not debug)", async () => {
		const networkErr = new Error("ETIMEDOUT");
		globalThis.fetch = jest.fn().mockRejectedValue(networkErr);
		const logger = makeLogger();
		const client = new WaybackDirectClient({ logger, ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ archiveUrl: expect.stringContaining("im_") }),
			expect.stringContaining("fetch error"),
		);
		expect(logger.debug).not.toHaveBeenCalledWith(
			expect.objectContaining({ archiveUrl: expect.anything() }),
			expect.stringContaining("fetch error"),
		);
	});
});

// ---------------------------------------------------------------------------
// Token bucket (fake timers)
// ---------------------------------------------------------------------------

describe("WaybackDirectClient token bucket", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Minimal fetch stub that resolves immediately
		globalThis.fetch = jest.fn().mockResolvedValue(makeFetchResponse({ status: 200, body: "" }));
		jest.useFakeTimers();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		jest.useRealTimers();
	});

	it("with rate=20/s burst=30, at most 30 calls issue immediately in the first burst", async () => {
		// Client with rate=20/s burst=30
		const client = new WaybackDirectClient({
			ratePerSecond: 20,
			burst: 30,
			timeoutMs: 10_000,
			logger: makeLogger(),
		});

		const TOTAL = 50;
		const promises: Promise<unknown>[] = [];

		// Kick off all 50 requests at t=0. The first `burst` (30) tokens are
		// available immediately. The remaining 20 must wait.
		for (let i = 0; i < TOTAL; i++) {
			promises.push(client.fetchAtResolvedTime("http://example.com/", "20200101000000"));
		}

		// Flush microtasks so the already-available tokens are consumed.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// At this point, fetch should have been called for the burst of 30 calls,
		// but not for the remaining 20 which are waiting on setTimeout.
		const callsBefore = (globalThis.fetch as jest.Mock).mock.calls.length;
		expect(callsBefore).toBeLessThanOrEqual(30);

		// Advance time by 1 second so the remaining 20 tokens accumulate.
		jest.advanceTimersByTime(1_000);
		// Flush again
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Resolve all pending
		await Promise.allSettled(promises);
		const callsAfter = (globalThis.fetch as jest.Mock).mock.calls.length;
		expect(callsAfter).toBe(TOTAL);
	});

	it("reads DIRECT_FETCH_TIMEOUT_MS from environment when no timeoutMs is given", () => {
		const orig = process.env.DIRECT_FETCH_TIMEOUT_MS;
		process.env.DIRECT_FETCH_TIMEOUT_MS = "7777";
		const client = new WaybackDirectClient({ logger: makeLogger() });
		// Access the private field via cast to verify it was set
		expect((client as unknown as { timeoutMs: number }).timeoutMs).toBe(7777);
		process.env.DIRECT_FETCH_TIMEOUT_MS = orig;
	});
});

// ---------------------------------------------------------------------------
// ECONNREFUSED circuit breaker
// ---------------------------------------------------------------------------

function makeEconnRefusedError(): TypeError {
	const cause = new Error("connect ECONNREFUSED 127.0.0.1:443");
	(cause as { code?: string }).code = "ECONNREFUSED";
	const err = new TypeError("fetch failed");
	(err as { cause?: unknown }).cause = cause;
	return err;
}

describe("WaybackDirectClient circuit breaker", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		jest.useRealTimers();
	});

	it("CLOSED → OPEN on first ECONNREFUSED; subsequent calls short-circuit without fetch", async () => {
		const fetchMock = jest.fn().mockRejectedValue(makeEconnRefusedError());
		globalThis.fetch = fetchMock;
		const client = makeClient({
			ratePerSecond: 1000,
			burst: 1000,
			timeoutMs: 10_000,
			breakerBaseMs: 5_000,
			breakerMaxMs: 60_000,
		});

		const r1 = await client.fetchAtResolvedTime("http://a.com/", "20200101000000");
		expect(r1.outcome).toBe("fallback");
		expect(r1.reason).toMatch(/^ECONNREFUSED/);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const r2 = await client.fetchAtResolvedTime("http://b.com/", "20200101000000");
		expect(r2).toEqual({ outcome: "fallback", reason: "circuit-open" });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// fetchAtRequestedTime shares the same breaker — also short-circuits.
		const r3 = await client.fetchAtRequestedTime("http://c.com/", "20200101000000");
		expect(r3).toEqual({ outcome: "fallback", reason: "circuit-open" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("non-ECONNREFUSED fetch errors do NOT trip the breaker", async () => {
		const fetchMock = jest.fn().mockRejectedValue(new Error("AbortError: timeout"));
		globalThis.fetch = fetchMock;
		const client = makeClient({
			ratePerSecond: 1000,
			burst: 1000,
			timeoutMs: 10_000,
			breakerBaseMs: 5_000,
			breakerMaxMs: 60_000,
		});

		await client.fetchAtResolvedTime("u", "20200101000000");
		await client.fetchAtResolvedTime("u", "20200101000000");
		await client.fetchAtResolvedTime("u", "20200101000000");
		// All three calls hit the network — breaker stayed CLOSED.
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("non-ECONNREFUSED HTTP responses (5xx, 404, 200) do NOT trip the breaker", async () => {
		const fetchMock = jest.fn();
		fetchMock.mockResolvedValueOnce(makeFetchResponse({ status: 503 }));
		fetchMock.mockResolvedValueOnce(makeFetchResponse({ status: 404 }));
		fetchMock.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: "x" }));
		globalThis.fetch = fetchMock;
		const client = makeClient({
			ratePerSecond: 1000,
			burst: 1000,
			timeoutMs: 10_000,
			breakerBaseMs: 5_000,
			breakerMaxMs: 60_000,
		});

		await client.fetchAtResolvedTime("u", "20200101000000");
		await client.fetchAtResolvedTime("u", "20200101000000");
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("HALF_OPEN probe success closes the circuit; subsequent traffic flows normally", async () => {
		jest.useFakeTimers({ now: 1_000_000 });
		const fetchMock = jest.fn();
		fetchMock.mockRejectedValueOnce(makeEconnRefusedError()); // opens
		fetchMock.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: "probe-ok" })); // probe
		fetchMock.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: "after-close" }));
		globalThis.fetch = fetchMock;

		const client = makeClient({
			ratePerSecond: 1000,
			burst: 1000,
			timeoutMs: 10_000,
			breakerBaseMs: 5_000,
			breakerMaxMs: 60_000,
		});

		// Open the breaker.
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Before cooldown expires: short-circuited.
		jest.setSystemTime(1_004_999);
		const blocked = await client.fetchAtResolvedTime("u", "20200101000000");
		expect(blocked.reason).toBe("circuit-open");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// At cooldown expiry: probe fires and succeeds.
		jest.setSystemTime(1_005_000);
		const probe = await client.fetchAtResolvedTime("u", "20200101000000");
		expect(probe.outcome).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Breaker now CLOSED — next call flows through.
		const after = await client.fetchAtResolvedTime("u", "20200101000000");
		expect(after.outcome).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("HALF_OPEN probe ECONNREFUSED doubles cooldown each round, capped at maxMs", async () => {
		jest.useFakeTimers({ now: 0 });
		const fetchMock = jest.fn().mockRejectedValue(makeEconnRefusedError());
		globalThis.fetch = fetchMock;
		const client = makeClient({
			ratePerSecond: 1000,
			burst: 1000,
			timeoutMs: 10_000,
			breakerBaseMs: 1_000,
			breakerMaxMs: 8_000,
		});

		// t=0: open the breaker, cooldown=1000.
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// t=999: still in cooldown.
		jest.setSystemTime(999);
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// t=1000: probe fires + fails → cooldown doubles to 2000.
		jest.setSystemTime(1_000);
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// t=2999: still in cooldown (probe failed at t=1000, expires at t=3000).
		jest.setSystemTime(2_999);
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// t=3000: probe #2 fires + fails → cooldown doubles to 4000.
		jest.setSystemTime(3_000);
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(3);

		// t=6999: still cooldown (expires at 7000).
		jest.setSystemTime(6_999);
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(3);

		// t=7000: probe #3 fires + fails → cooldown caps at 8000 (would be 8000 from 4000*2).
		jest.setSystemTime(7_000);
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(4);

		// t=15000: probe #4 fires + fails → cooldown stays at 8000 (cap).
		jest.setSystemTime(15_000);
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(5);

		// t=22999: still in cooldown (expires at 23000).
		jest.setSystemTime(22_999);
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(5);

		// t=23000: another probe — cap held.
		jest.setSystemTime(23_000);
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it("concurrent calls during HALF_OPEN get circuit-half-open-busy fast-fail; only one probe", async () => {
		jest.useFakeTimers({ now: 0 });
		let resolveProbe!: (r: Response) => void;
		const probePromise = new Promise<Response>((r) => {
			resolveProbe = r;
		});

		const fetchMock = jest.fn();
		fetchMock.mockRejectedValueOnce(makeEconnRefusedError()); // opens
		fetchMock.mockReturnValueOnce(probePromise); // probe (held)
		globalThis.fetch = fetchMock;

		const client = makeClient({
			ratePerSecond: 1000,
			burst: 1000,
			timeoutMs: 10_000,
			breakerBaseMs: 1_000,
			breakerMaxMs: 60_000,
		});

		// Open breaker.
		await client.fetchAtResolvedTime("u", "20200101000000");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// At cooldown expiry: kick off the probe (in flight, not awaited).
		jest.setSystemTime(1_000);
		const probeCall = client.fetchAtResolvedTime("u", "20200101000000");
		// One microtask flush so the probe's tryAcquire + fetch dispatch settle.
		await Promise.resolve();

		// Concurrent calls now short-circuit with half-open-busy.
		const r1 = await client.fetchAtResolvedTime("u", "20200101000000");
		const r2 = await client.fetchAtRequestedTime("u", "20200101000000");
		expect(r1).toEqual({ outcome: "fallback", reason: "circuit-half-open-busy" });
		expect(r2).toEqual({ outcome: "fallback", reason: "circuit-half-open-busy" });
		// Only the probe touched the network.
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Resolve probe successfully → breaker closes.
		resolveProbe(makeFetchResponse({ status: 200, body: "probe-ok" }));
		const probeResult = await probeCall;
		expect(probeResult.outcome).toBe("ok");

		// Subsequent call flows normally.
		fetchMock.mockResolvedValueOnce(makeFetchResponse({ status: 200, body: "after" }));
		const after = await client.fetchAtResolvedTime("u", "20200101000000");
		expect(after.outcome).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
