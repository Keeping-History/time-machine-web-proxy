import { ArchiveRequestQueue } from "../../src/lib/queue";

const makeResponse = (status = 200) => new Response(null, { status });

const neverResolve = (): Promise<Response> => new Promise(() => {});

describe("ArchiveRequestQueue", () => {
	describe("pending and running getters", () => {
		it("starts at zero", () => {
			const q = new ArchiveRequestQueue(2, 100, 100);
			expect(q.pending).toBe(0);
			expect(q.running).toBe(0);
		});
	});

	describe("enqueue", () => {
		it("executes a task and resolves the returned promise", async () => {
			const q = new ArchiveRequestQueue(2, 100, 100);
			const result = await q.enqueue(() => Promise.resolve(makeResponse(200)));
			expect(result.status).toBe(200);
		});

		it("rejects when queue is full", async () => {
			// maxConcurrent=1, maxQueueSize=1: 1 running + 1 pending = full
			const q = new ArchiveRequestQueue(1, 100, 100, 1);
			// First task starts immediately (running slot)
			q.enqueue(neverResolve);
			// Second task goes to pending queue (fills maxQueueSize=1)
			q.enqueue(neverResolve);
			// Third is rejected
			await expect(q.enqueue(neverResolve)).rejects.toMatchObject({
				message: "Too many pending requests",
				status: 503,
			});
		});

		it("respects maxConcurrent — does not run more tasks than the cap", async () => {
			const q = new ArchiveRequestQueue(2, 100, 100);
			let concurrent = 0;
			let maxSeen = 0;

			const task = () =>
				new Promise<Response>((resolve) => {
					concurrent++;
					maxSeen = Math.max(maxSeen, concurrent);
					setImmediate(() => {
						concurrent--;
						resolve(makeResponse());
					});
				});

			await Promise.all([q.enqueue(task), q.enqueue(task), q.enqueue(task)]);
			expect(maxSeen).toBeLessThanOrEqual(2);
		});
	});

	describe("abort", () => {
		it("rejects all pending tasks", async () => {
			const q = new ArchiveRequestQueue(1, 100, 100);
			// First task occupies the running slot — attach .catch so it's not unhandled
			q.enqueue(neverResolve).catch(() => {});
			// Register rejection assertions before calling abort so handlers are
			// in place when abort() synchronously rejects the pending entries
			const p2 = q.enqueue(neverResolve);
			const p3 = q.enqueue(neverResolve);
			const assert2 = expect(p2).rejects.toThrow("Server shutting down");
			const assert3 = expect(p3).rejects.toThrow("Server shutting down");
			q.abort();
			await assert2;
			await assert3;
		});

		it("clears the pending queue after abort", () => {
			const q = new ArchiveRequestQueue(1, 100, 100);
			// Attach .catch so the rejected pending promise doesn't go unhandled
			q.enqueue(neverResolve).catch(() => {});
			q.enqueue(neverResolve).catch(() => {});
			expect(q.pending).toBe(1);
			q.abort();
			expect(q.pending).toBe(0);
		});
	});
});
