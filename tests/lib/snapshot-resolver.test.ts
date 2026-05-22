import pino from "pino";
import { MAX_TIMESTAMP, resolveSnapshotTimestamp } from "../../src/lib/snapshot-resolver";

const logger = pino({ level: "silent" });

const mkCdxResponse = (timestamps: string[]): Response =>
	new Response(JSON.stringify([["timestamp"], ...timestamps.map((t) => [t])]));

const mkEmptyResponse = (): Response => new Response("[]");

describe("resolveSnapshotTimestamp", () => {
	it("returns latest ts in first window when results exist", async () => {
		const fetchImpl = jest
			.fn()
			.mockResolvedValue(mkCdxResponse(["20010917011416", "20010918010000"]));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://www.apple.com/"],
			requestedTime: "20011001000000",
			windowsDays: [30, 365, 0],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBe("20010918010000");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("widens to next window when narrower returns empty", async () => {
		const fetchImpl = jest
			.fn()
			.mockResolvedValueOnce(mkEmptyResponse())
			.mockResolvedValueOnce(mkCdxResponse(["20000515120000"]));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20010101000000",
			windowsDays: [30, 365],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBe("20000515120000");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("returns max across variants in same window", async () => {
		const fetchImpl = jest
			.fn()
			.mockResolvedValueOnce(mkCdxResponse(["20010917011416"]))
			.mockResolvedValueOnce(mkCdxResponse(["20010920000000"]));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://www.apple.com/", "https://apple.com/"],
			requestedTime: "20011001000000",
			windowsDays: [30],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBe("20010920000000");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("throws when every CDX query returns non-OK (transient outage, not 'no snapshot')", async () => {
		const fetchImpl = jest.fn().mockResolvedValue(new Response("server error", { status: 500 }));
		await expect(
			resolveSnapshotTimestamp({
				variants: ["https://x/"],
				requestedTime: "20010101000000",
				windowsDays: [30],
				allowLaterFallback: false,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				logger,
			}),
		).rejects.toThrow(/all CDX queries failed/i);
	});

	it("throws when every CDX query returns malformed JSON (proxy injecting HTML, etc.)", async () => {
		// mockImplementation (not mockResolvedValue) so each call gets a fresh
		// Response — retry consumes the body on each attempt, so a single
		// shared Response instance would throw "body already used" on retry 2.
		const fetchImpl = jest.fn().mockImplementation(async () => new Response("not json"));
		await expect(
			resolveSnapshotTimestamp({
				variants: ["https://x/"],
				requestedTime: "20010101000000",
				windowsDays: [30],
				allowLaterFallback: false,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				logger,
			}),
		).rejects.toThrow(/all CDX queries failed/i);
	});

	it("throws when every CDX fetch rejects (network down) — refuses to cache a phantom 404", async () => {
		const fetchImpl = jest.fn().mockRejectedValue(new Error("network down"));
		await expect(
			resolveSnapshotTimestamp({
				variants: ["https://x/"],
				requestedTime: "20010101000000",
				windowsDays: [30],
				allowLaterFallback: false,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				logger,
			}),
		).rejects.toThrow(/all CDX queries failed/i);
	});

	it("returns null (not throw) when at least one CDX succeeds with empty array — that's authoritative 'no snapshots'", async () => {
		// Two variants: one persistently transport-fails (across retries),
		// one returns valid empty. The empty response is the "real" answer;
		// the transient failure must not poison the resolver into throwing.
		// Per-URL impl (not Once) so retries on the broken variant keep
		// failing instead of pulling the "ok" mock by accident.
		const fetchImpl = jest.fn().mockImplementation(async (input: string) => {
			if (input.includes("broken")) throw new Error("network down");
			return new Response("[]");
		});
		const result = await resolveSnapshotTimestamp({
			variants: ["https://broken/", "https://ok/"],
			requestedTime: "20010101000000",
			windowsDays: [30],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBeNull();
	});

	it("returns null when all backward windows exhausted and fallback disabled", async () => {
		const fetchImpl = jest.fn(() => Promise.resolve(mkEmptyResponse()));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20010101000000",
			windowsDays: [30, 365, 0],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBeNull();
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("bidirectional: returns closest forward ts when only later snapshots exist in window", async () => {
		// Window 30 (req=20010101): empty. Window 365: contains two later
		// captures; 20010917 is closer to req than 20010920, so it wins.
		const fetchImpl = jest
			.fn()
			.mockResolvedValueOnce(mkEmptyResponse())
			.mockResolvedValueOnce(mkCdxResponse(["20010920000000", "20010917011416"]));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20010101000000",
			windowsDays: [30, 365, 0],
			allowLaterFallback: true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBe("20010917011416");
		// One bidirectional call per window — no separate backward/forward passes.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("bidirectional: prefers nearer forward capture over farther backward (IBM 2001-09-13 regression)", async () => {
		// requestedTime midnight 2001-09-13; backward window also contains a
		// Sept 9 capture, forward window contains Sept 13 10:08am. The forward
		// one is ~10h away, the backward one is ~4d away — forward wins.
		const fetchImpl = jest
			.fn()
			.mockResolvedValueOnce(mkCdxResponse(["20010909062018", "20010913100802"]));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://www.ibm.com/"],
			requestedTime: "20010913000000",
			windowsDays: [30],
			allowLaterFallback: true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBe("20010913100802");
	});

	it("bidirectional: queries each window once with from=req-days,to=req+days", async () => {
		const fetchImpl = jest.fn().mockResolvedValue(mkEmptyResponse());
		await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20010913000000",
			windowsDays: [30],
			allowLaterFallback: true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const calledUrl = (fetchImpl.mock.calls[0] as unknown as [string])[0];
		const parsed = new URL(calledUrl);
		// Backward 30 days from Sept 13 = Aug 14; forward 30 days = Oct 13.
		expect(parsed.searchParams.get("from")).toBe("20010814000000");
		expect(parsed.searchParams.get("to")).toBe("20011013000000");
	});

	it("returns null when both directions exhausted (fallback on)", async () => {
		const fetchImpl = jest.fn(() => Promise.resolve(mkEmptyResponse()));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20010101000000",
			windowsDays: [30, 0],
			allowLaterFallback: true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBeNull();
		// One combined bidirectional call per window — half the calls vs the
		// legacy backward-then-forward pass.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("constructs CDX URL with correct params (url, output, fl, filter, from, to)", async () => {
		const fetchImpl = jest.fn().mockResolvedValue(mkEmptyResponse());
		await resolveSnapshotTimestamp({
			variants: ["https://www.apple.com/"],
			requestedTime: "20010912000000",
			windowsDays: [30],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		const calledUrl = (fetchImpl.mock.calls[0] as unknown as [string])[0];
		const parsed = new URL(calledUrl);
		expect(parsed.hostname).toBe("web.archive.org");
		expect(parsed.searchParams.get("url")).toBe("https://www.apple.com/");
		expect(parsed.searchParams.get("output")).toBe("json");
		expect(parsed.searchParams.get("fl")).toBe("timestamp");
		expect(parsed.searchParams.get("filter")).toBe("statuscode:200");
		expect(parsed.searchParams.get("to")).toBe("20010912000000");
		expect(parsed.searchParams.get("from")).toBe("20010813000000");
	});

	it("omits from param when window is 0 (unbounded backward)", async () => {
		const fetchImpl = jest.fn().mockResolvedValue(mkEmptyResponse());
		await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20010101000000",
			windowsDays: [0],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		const calledUrl = (fetchImpl.mock.calls[0] as unknown as [string])[0];
		expect(new URL(calledUrl).searchParams.get("from")).toBeNull();
	});

	it("clamps from to MIN_TIMESTAMP when subtraction underflows", async () => {
		const fetchImpl = jest.fn().mockResolvedValue(mkEmptyResponse());
		await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "19960201000000",
			windowsDays: [365],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		const calledUrl = (fetchImpl.mock.calls[0] as unknown as [string])[0];
		expect(new URL(calledUrl).searchParams.get("from")).toBe("19960101000000");
	});

	it("clamps forward 'to' to MAX_TIMESTAMP when addition overflows", async () => {
		// Pin requestedTime at the upper bound so shiftTimestamp(+365) overflows;
		// the bidirectional call's 'to' must clamp to MAX_TIMESTAMP.
		const fetchImpl = jest.fn().mockImplementation(() => Promise.resolve(mkEmptyResponse()));
		await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: MAX_TIMESTAMP,
			windowsDays: [365],
			allowLaterFallback: true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const calledUrl = (fetchImpl.mock.calls[0] as unknown as [string])[0];
		expect(new URL(calledUrl).searchParams.get("to")).toBe(MAX_TIMESTAMP);
	});

	it("skips backward search entirely when first window finds match", async () => {
		const fetchImpl = jest.fn().mockResolvedValueOnce(mkCdxResponse(["20010917011416"]));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20011001000000",
			windowsDays: [30, 365, 0],
			allowLaterFallback: true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBe("20010917011416");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed requestedTime", async () => {
		const fetchImpl = jest.fn();
		await expect(
			resolveSnapshotTimestamp({
				variants: ["https://x/"],
				requestedTime: "not-a-ts",
				windowsDays: [30],
				allowLaterFallback: false,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				logger,
			}),
		).rejects.toThrow(/timestamp/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// --- CDX retry/backoff ----------------------------------------------------

	describe("CDX retry/backoff", () => {
		// Tests in this block use jest.useFakeTimers() to skip the
		// CDX_RETRY_BASE_DELAY_MS waits; without it each retry test would block
		// for up to 1.5s real time.
		beforeEach(() => {
			jest.useFakeTimers();
		});
		afterEach(() => {
			jest.useRealTimers();
		});

		async function runWithTimers<T>(p: Promise<T>): Promise<T> {
			// Repeatedly flush microtasks + timers until the promise resolves.
			// Each retry has a setTimeout(backoff) that must fire before the
			// next attempt; jest's runAllTimersAsync drains the queue end-to-end.
			let settled = false;
			let value!: T;
			let err: unknown;
			p.then(
				(v) => {
					value = v;
					settled = true;
				},
				(e) => {
					err = e;
					settled = true;
				},
			);
			while (!settled) {
				await jest.runAllTimersAsync();
			}
			if (err !== undefined) throw err;
			return value;
		}

		it("retries on transport error and succeeds on the second attempt", async () => {
			const fetchImpl = jest
				.fn()
				.mockRejectedValueOnce(new Error("ECONNRESET"))
				.mockResolvedValueOnce(mkCdxResponse(["20010917000000"]));
			const result = await runWithTimers(
				resolveSnapshotTimestamp({
					variants: ["https://x/"],
					requestedTime: "20011001000000",
					windowsDays: [30],
					allowLaterFallback: false,
					fetchImpl: fetchImpl as unknown as typeof fetch,
					logger,
				}),
			);
			expect(result).toBe("20010917000000");
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		});

		it("retries on 5xx status and succeeds on the second attempt", async () => {
			const fetchImpl = jest
				.fn()
				.mockResolvedValueOnce(new Response("svc unavailable", { status: 503 }))
				.mockResolvedValueOnce(mkCdxResponse(["20010917000000"]));
			const result = await runWithTimers(
				resolveSnapshotTimestamp({
					variants: ["https://x/"],
					requestedTime: "20011001000000",
					windowsDays: [30],
					allowLaterFallback: false,
					fetchImpl: fetchImpl as unknown as typeof fetch,
					logger,
				}),
			);
			expect(result).toBe("20010917000000");
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		});

		it("retries on 429 (rate limit) and succeeds on the second attempt", async () => {
			const fetchImpl = jest
				.fn()
				.mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
				.mockResolvedValueOnce(mkCdxResponse(["20010917000000"]));
			const result = await runWithTimers(
				resolveSnapshotTimestamp({
					variants: ["https://x/"],
					requestedTime: "20011001000000",
					windowsDays: [30],
					allowLaterFallback: false,
					fetchImpl: fetchImpl as unknown as typeof fetch,
					logger,
				}),
			);
			expect(result).toBe("20010917000000");
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		});

		it("retries on malformed JSON and succeeds on the second attempt", async () => {
			const fetchImpl = jest
				.fn()
				.mockResolvedValueOnce(new Response("<html>error</html>"))
				.mockResolvedValueOnce(mkCdxResponse(["20010917000000"]));
			const result = await runWithTimers(
				resolveSnapshotTimestamp({
					variants: ["https://x/"],
					requestedTime: "20011001000000",
					windowsDays: [30],
					allowLaterFallback: false,
					fetchImpl: fetchImpl as unknown as typeof fetch,
					logger,
				}),
			);
			expect(result).toBe("20010917000000");
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		});

		it("does NOT retry on 4xx non-429 (treats as authoritative non-OK)", async () => {
			const fetchImpl = jest.fn().mockResolvedValue(new Response("not found", { status: 404 }));
			await expect(
				runWithTimers(
					resolveSnapshotTimestamp({
						variants: ["https://x/"],
						requestedTime: "20010101000000",
						windowsDays: [30],
						allowLaterFallback: false,
						fetchImpl: fetchImpl as unknown as typeof fetch,
						logger,
					}),
				),
			).rejects.toThrow(/all CDX queries failed/i);
			// 1 variant × 1 window × 1 attempt (no retry on 4xx).
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});

		it("gives up after CDX_RETRY_MAX_ATTEMPTS on persistent 500s and falls through to throw", async () => {
			const fetchImpl = jest.fn().mockResolvedValue(new Response("boom", { status: 500 }));
			await expect(
				runWithTimers(
					resolveSnapshotTimestamp({
						variants: ["https://x/"],
						requestedTime: "20010101000000",
						windowsDays: [30],
						allowLaterFallback: false,
						fetchImpl: fetchImpl as unknown as typeof fetch,
						logger,
					}),
				),
			).rejects.toThrow(/all CDX queries failed/i);
			// 1 variant × 1 window × 3 attempts (initial + 2 retries).
			expect(fetchImpl).toHaveBeenCalledTimes(3);
		});

		it("gives up after CDX_RETRY_MAX_ATTEMPTS on persistent transport rejections", async () => {
			const fetchImpl = jest.fn().mockRejectedValue(new Error("network down"));
			await expect(
				runWithTimers(
					resolveSnapshotTimestamp({
						variants: ["https://x/"],
						requestedTime: "20010101000000",
						windowsDays: [30],
						allowLaterFallback: false,
						fetchImpl: fetchImpl as unknown as typeof fetch,
						logger,
					}),
				),
			).rejects.toThrow(/all CDX queries failed/i);
			expect(fetchImpl).toHaveBeenCalledTimes(3);
		});

		it("recovery scenario from the production bug — all variants 5xx then 200 on retry", async () => {
			// Two variants. Both fail with 503 on attempt 1, both succeed on attempt 2.
			// Before the retry change this would throw 'all CDX queries failed'.
			const fetchImpl = jest
				.fn()
				.mockResolvedValueOnce(new Response("", { status: 503 })) // variant A, attempt 1
				.mockResolvedValueOnce(new Response("", { status: 503 })) // variant B, attempt 1
				.mockResolvedValueOnce(mkCdxResponse(["20010917000000"])) // variant A, attempt 2
				.mockResolvedValueOnce(mkEmptyResponse()); // variant B, attempt 2
			const result = await runWithTimers(
				resolveSnapshotTimestamp({
					variants: ["https://www.x/", "https://x/"],
					requestedTime: "20011001000000",
					windowsDays: [30],
					allowLaterFallback: false,
					fetchImpl: fetchImpl as unknown as typeof fetch,
					logger,
				}),
			);
			expect(result).toBe("20010917000000");
			expect(fetchImpl).toHaveBeenCalledTimes(4);
		});
	});
});
