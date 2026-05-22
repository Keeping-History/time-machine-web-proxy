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

	it("treats non-OK CDX response as empty", async () => {
		const fetchImpl = jest.fn().mockResolvedValue(new Response("server error", { status: 500 }));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20010101000000",
			windowsDays: [30],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBeNull();
	});

	it("treats malformed CDX JSON as empty", async () => {
		const fetchImpl = jest.fn().mockResolvedValue(new Response("not json"));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20010101000000",
			windowsDays: [30],
			allowLaterFallback: false,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBeNull();
	});

	it("treats fetch rejection as empty", async () => {
		const fetchImpl = jest.fn().mockRejectedValue(new Error("network down"));
		const result = await resolveSnapshotTimestamp({
			variants: ["https://x/"],
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

	it("returns earliest forward ts when fallback enabled and only later snapshots exist", async () => {
		let callCount = 0;
		const fetchImpl = jest.fn().mockImplementation(() => {
			callCount++;
			if (callCount <= 3) return Promise.resolve(mkEmptyResponse());
			return Promise.resolve(mkCdxResponse(["20010920000000", "20010917011416"]));
		});
		const result = await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: "20010101000000",
			windowsDays: [30, 365, 0],
			allowLaterFallback: true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		expect(result).toBe("20010917011416");
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
		expect(fetchImpl).toHaveBeenCalledTimes(4);
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
		// the forward-fallback call should still use MAX_TIMESTAMP for 'to'.
		// Use mockImplementation so each call gets a fresh Response (body is single-use).
		const fetchImpl = jest.fn().mockImplementation(() => Promise.resolve(mkEmptyResponse()));
		await resolveSnapshotTimestamp({
			variants: ["https://x/"],
			requestedTime: MAX_TIMESTAMP,
			windowsDays: [365],
			allowLaterFallback: true,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			logger,
		});
		// calls[0] = backward window; calls[1] = forward window with the clamped 'to'.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const forwardUrl = (fetchImpl.mock.calls[1] as unknown as [string])[0];
		expect(new URL(forwardUrl).searchParams.get("to")).toBe(MAX_TIMESTAMP);
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
