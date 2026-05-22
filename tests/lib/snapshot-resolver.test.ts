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
		const fetchImpl = jest.fn().mockResolvedValue(new Response("not json"));
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
		// Two variants: one transport-fails, one returns valid empty. The empty
		// response is the "real" answer; the transient failure must not poison
		// the resolver into throwing.
		const fetchImpl = jest
			.fn()
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce(new Response("[]"));
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
});
