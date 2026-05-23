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
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 200, body: "" }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtResolvedTime("http://example.com/page", "20200615120000");
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://web.archive.org/web/20200615120000id_/http://example.com/page",
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("returns not_found on HTTP 404", async () => {
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 404 }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("not_found");
	});

	it("returns fallback on 3xx (redirect: manual)", async () => {
		for (const status of [301, 302, 307, 308]) {
			globalThis.fetch = jest
				.fn()
				.mockResolvedValue(makeFetchResponse({ status }));
			const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
			const result = await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
			expect(result.outcome).toBe("fallback");
			expect(result.reason).toMatch(/^redirect-/);
		}
	});

	it("returns fallback on 5xx", async () => {
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 503 }));
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
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 200, body: "" }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		const [, opts] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
		expect(opts.redirect).toBe("manual");
	});

	it("passes AbortSignal.timeout to fetch (respects timeoutMs)", async () => {
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 200, body: "" }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000, timeoutMs: 5000 });
		await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		const [, opts] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
		expect(opts.signal).toBeDefined();
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
		const finalUrl =
			"https://web.archive.org/web/20200615120000id_/http://example.com/page";
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
		globalThis.fetch = jest.fn().mockResolvedValue(
			makeFetchResponse({ status: 200, url: "", body: "" }),
		);
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://web.archive.org/web/20200101000000im_/http://example.com/",
			expect.objectContaining({ redirect: "follow" }),
		);
	});

	it("returns not_found on HTTP 404", async () => {
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 404 }));
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		const result = await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		expect(result.outcome).toBe("not_found");
	});

	it("returns fallback on 5xx", async () => {
		globalThis.fetch = jest
			.fn()
			.mockResolvedValue(makeFetchResponse({ status: 500 }));
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
		globalThis.fetch = jest.fn().mockResolvedValue(
			makeFetchResponse({ status: 200, url: "", body: "" }),
		);
		const client = makeClient({ ratePerSecond: 1000, burst: 1000 });
		await client.fetchAtRequestedTime("http://example.com/", "20200101000000");
		const [, opts] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
		expect(opts.redirect).toBe("follow");
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
		globalThis.fetch = jest.fn().mockResolvedValue(
			makeFetchResponse({ status: 200, body: "" }),
		);
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
