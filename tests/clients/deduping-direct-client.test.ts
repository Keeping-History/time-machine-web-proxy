// Tests for src/clients/deduping-direct-client.ts
//
// The inner WaybackDirectClient is replaced with a jest mock so we can control
// exactly when each upstream promise resolves. No real network calls are made.

import { Readable } from "node:stream";
import { DedupingDirectClient } from "../../src/clients/deduping-direct-client";
import type { WaybackDirectClient } from "../../src/clients/wayback-direct-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deferred promise — lets tests control when an upstream call settles. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
} {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type MockInner = {
	fetchAtResolvedTime: jest.Mock;
	fetchAtRequestedTime: jest.Mock;
};

function makeMockInner(): MockInner {
	return {
		fetchAtResolvedTime: jest.fn(),
		fetchAtRequestedTime: jest.fn(),
	};
}

const OK_RESOLVED = { outcome: "ok" as const, body: Readable.from(["r"]), contentType: "text/plain" };
const OK_REQUESTED = {
	outcome: "ok" as const,
	body: Readable.from(["q"]),
	contentType: "text/html",
	resolvedTime: "20200101000000",
};

// ---------------------------------------------------------------------------
// Dedup: two concurrent same-arg calls invoke inner client once
// ---------------------------------------------------------------------------

describe("DedupingDirectClient dedup", () => {
	it("two concurrent fetchAtResolvedTime calls with same args invoke inner once and both resolve identically", async () => {
		const mock = makeMockInner();
		const d = deferred<typeof OK_RESOLVED>();
		mock.fetchAtResolvedTime.mockReturnValue(d.promise);

		const client = new DedupingDirectClient(mock as unknown as WaybackDirectClient);

		const p1 = client.fetchAtResolvedTime("http://example.com/sprite.png", "20200101000000");
		const p2 = client.fetchAtResolvedTime("http://example.com/sprite.png", "20200101000000");

		// Inner should have been called only once at this point (before resolving)
		expect(mock.fetchAtResolvedTime).toHaveBeenCalledTimes(1);

		d.resolve(OK_RESOLVED);
		const [r1, r2] = await Promise.all([p1, p2]);

		expect(r1).toBe(r2); // same object reference — shared promise
		expect(mock.fetchAtResolvedTime).toHaveBeenCalledTimes(1);
	});

	it("two concurrent fetchAtRequestedTime calls with same args invoke inner once and both resolve identically", async () => {
		const mock = makeMockInner();
		const d = deferred<typeof OK_REQUESTED>();
		mock.fetchAtRequestedTime.mockReturnValue(d.promise);

		const client = new DedupingDirectClient(mock as unknown as WaybackDirectClient);

		const p1 = client.fetchAtRequestedTime("http://example.com/page", "20200101000000");
		const p2 = client.fetchAtRequestedTime("http://example.com/page", "20200101000000");

		expect(mock.fetchAtRequestedTime).toHaveBeenCalledTimes(1);

		d.resolve(OK_REQUESTED);
		const [r1, r2] = await Promise.all([p1, p2]);

		expect(r1).toBe(r2);
		expect(mock.fetchAtRequestedTime).toHaveBeenCalledTimes(1);
	});

	it("second call after first has settled triggers a fresh inner call (map is cleared)", async () => {
		const mock = makeMockInner();
		mock.fetchAtResolvedTime.mockResolvedValue(OK_RESOLVED);

		const client = new DedupingDirectClient(mock as unknown as WaybackDirectClient);

		await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		await client.fetchAtResolvedTime("http://example.com/", "20200101000000");

		// Each settled call clears the map, so the second call is a fresh upstream request
		expect(mock.fetchAtResolvedTime).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Failure clears map so next call retries
// ---------------------------------------------------------------------------

describe("DedupingDirectClient failure handling", () => {
	it("rejected call clears the inflight entry so a subsequent call retries (inner called twice)", async () => {
		const mock = makeMockInner();
		const err = new Error("network error");

		mock.fetchAtResolvedTime.mockRejectedValueOnce(err).mockResolvedValueOnce(OK_RESOLVED);

		const client = new DedupingDirectClient(mock as unknown as WaybackDirectClient);

		// First call — should reject
		await expect(
			client.fetchAtResolvedTime("http://example.com/", "20200101000000"),
		).rejects.toThrow("network error");

		// Second call — inflight map must be clear so it retries
		const result = await client.fetchAtResolvedTime("http://example.com/", "20200101000000");

		expect(result.outcome).toBe("ok");
		expect(mock.fetchAtResolvedTime).toHaveBeenCalledTimes(2);
	});

	it("two concurrent callers both receive the rejection when the shared call fails", async () => {
		const mock = makeMockInner();
		const d = deferred<typeof OK_RESOLVED>();
		mock.fetchAtResolvedTime.mockReturnValue(d.promise);

		const client = new DedupingDirectClient(mock as unknown as WaybackDirectClient);

		const p1 = client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		const p2 = client.fetchAtResolvedTime("http://example.com/", "20200101000000");

		const err = new Error("upstream failure");
		d.reject(err);

		await expect(p1).rejects.toThrow("upstream failure");
		await expect(p2).rejects.toThrow("upstream failure");

		// Map should be cleared after rejection
		mock.fetchAtResolvedTime.mockResolvedValueOnce(OK_RESOLVED);
		const r3 = await client.fetchAtResolvedTime("http://example.com/", "20200101000000");
		expect(r3.outcome).toBe("ok");
		expect(mock.fetchAtResolvedTime).toHaveBeenCalledTimes(2); // 1 shared + 1 retry
	});
});

// ---------------------------------------------------------------------------
// Concurrency cap
// ---------------------------------------------------------------------------

describe("DedupingDirectClient concurrency cap", () => {
	it("with cap=2 and 5 distinct-URL calls, at most 2 are in flight simultaneously", async () => {
		const mock = makeMockInner();
		const deferreds = Array.from({ length: 5 }, () => deferred<typeof OK_RESOLVED>());

		// Track in-flight count via call counts on the mock, not via .finally().
		// inFlight increments synchronously when the mock is called (i.e. when the
		// inner client starts a request).  It decrements synchronously when the
		// deferred is resolved by wrapping each deferred promise so the decrement
		// runs in the same microtask turn as the resolution — no .finally() hop.
		let inFlight = 0;
		let maxObservedInFlight = 0;

		deferreds.forEach((d) => {
			mock.fetchAtResolvedTime.mockImplementationOnce(() => {
				// Increment synchronously as soon as the mock is called
				inFlight++;
				maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);

				// Wrap d.promise so that when the deferred resolves, the decrement
				// runs in the first .then() — no extra microtask from .finally().
				return d.promise.then(
					(v) => {
						inFlight--;
						return v;
					},
					(e) => {
						inFlight--;
						return Promise.reject(e);
					},
				);
			});
		});

		const client = new DedupingDirectClient(mock as unknown as WaybackDirectClient, {
			maxConcurrency: 2,
		});

		const promises = deferreds.map((_, i) =>
			client.fetchAtResolvedTime(`http://example.com/asset-${i}.png`, "20200101000000"),
		);

		// Flush microtasks so the first 2 slots are acquired
		await Promise.resolve();
		await Promise.resolve();

		expect(inFlight).toBe(2);
		expect(maxObservedInFlight).toBe(2);

		// Resolve one — slot frees, third waiter should start.
		// Chain of microtasks after deferreds[0].resolve():
		//   1. d.promise resolves
		//   2. mock wrapper .then() runs: inFlight-- (now 1), returns OK_RESOLVED
		//   3. DedupingDirectClient .then() runs: release() → next() → mock called
		//      synchronously → inFlight++ (now 2), starts deferreds[2].promise
		// Two await Promise.resolve() flushes cover both hops.
		deferreds[0].resolve(OK_RESOLVED);
		await Promise.resolve();
		await Promise.resolve();

		expect(inFlight).toBe(2); // slot freed by [0], acquired by [2]
		expect(maxObservedInFlight).toBe(2);

		// Resolve remaining; each free one slot which the next waiter fills.
		deferreds[1].resolve(OK_RESOLVED);
		await Promise.resolve();
		await Promise.resolve();

		deferreds[2].resolve(OK_RESOLVED);
		await Promise.resolve();
		await Promise.resolve();

		deferreds[3].resolve(OK_RESOLVED);
		await Promise.resolve();
		await Promise.resolve();

		deferreds[4].resolve(OK_RESOLVED);

		await Promise.allSettled(promises);

		expect(maxObservedInFlight).toBeLessThanOrEqual(2);
		expect(mock.fetchAtResolvedTime).toHaveBeenCalledTimes(5);
	});
});

// ---------------------------------------------------------------------------
// fetchAtResolvedTime and fetchAtRequestedTime dedup independently
// ---------------------------------------------------------------------------

describe("DedupingDirectClient namespace isolation", () => {
	it("a fetchAtResolvedTime call does not satisfy a fetchAtRequestedTime call with same (url, ts)", async () => {
		const mock = makeMockInner();
		const dResolved = deferred<typeof OK_RESOLVED>();
		const dRequested = deferred<typeof OK_REQUESTED>();

		mock.fetchAtResolvedTime.mockReturnValue(dResolved.promise);
		mock.fetchAtRequestedTime.mockReturnValue(dRequested.promise);

		const client = new DedupingDirectClient(mock as unknown as WaybackDirectClient);

		const pResolved = client.fetchAtResolvedTime("http://example.com/sprite.png", "20200101000000");
		const pRequested = client.fetchAtRequestedTime(
			"http://example.com/sprite.png",
			"20200101000000",
		);

		// Both should have triggered separate upstream calls
		expect(mock.fetchAtResolvedTime).toHaveBeenCalledTimes(1);
		expect(mock.fetchAtRequestedTime).toHaveBeenCalledTimes(1);

		dResolved.resolve(OK_RESOLVED);
		dRequested.resolve(OK_REQUESTED);

		const [rRes, rReq] = await Promise.all([pResolved, pRequested]);

		expect(rRes).toEqual(OK_RESOLVED);
		expect(rReq).toEqual(OK_REQUESTED);
	});

	it("concurrent resolved-ts calls share a promise; concurrent requested-ts calls share a separate promise", async () => {
		const mock = makeMockInner();
		const dRes1 = deferred<typeof OK_RESOLVED>();
		const dReq1 = deferred<typeof OK_REQUESTED>();

		mock.fetchAtResolvedTime.mockReturnValue(dRes1.promise);
		mock.fetchAtRequestedTime.mockReturnValue(dReq1.promise);

		const client = new DedupingDirectClient(mock as unknown as WaybackDirectClient);

		const pRes1 = client.fetchAtResolvedTime("http://example.com/x.css", "20200101000000");
		const pRes2 = client.fetchAtResolvedTime("http://example.com/x.css", "20200101000000");
		const pReq1 = client.fetchAtRequestedTime("http://example.com/x.css", "20200101000000");
		const pReq2 = client.fetchAtRequestedTime("http://example.com/x.css", "20200101000000");

		// One upstream call per method
		expect(mock.fetchAtResolvedTime).toHaveBeenCalledTimes(1);
		expect(mock.fetchAtRequestedTime).toHaveBeenCalledTimes(1);

		dRes1.resolve(OK_RESOLVED);
		dReq1.resolve(OK_REQUESTED);

		const [r1, r2, q1, q2] = await Promise.all([pRes1, pRes2, pReq1, pReq2]);

		expect(r1).toBe(r2); // same shared promise
		expect(q1).toBe(q2); // same shared promise
		expect(r1).not.toBe(q1); // different method → different promise
	});
});
