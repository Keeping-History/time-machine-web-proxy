import { abortableSleep, ShutdownController } from "../../src/lib/shutdown";

describe("abortableSleep", () => {
	it("resolves after the specified duration", async () => {
		const controller = new ShutdownController();
		await expect(abortableSleep(10, controller.signal)).resolves.toBeUndefined();
	});

	it("rejects immediately if signal is already aborted", async () => {
		const controller = new ShutdownController();
		controller.abort();
		await expect(abortableSleep(1_000, controller.signal)).rejects.toThrow("Server shutting down");
	});

	it("rejects mid-sleep when signal is aborted", async () => {
		const controller = new ShutdownController();
		const sleepPromise = abortableSleep(10_000, controller.signal);
		setTimeout(() => controller.abort(), 10);
		await expect(sleepPromise).rejects.toThrow("Server shutting down");
	});
});

describe("ShutdownController", () => {
	it("exposes signal from the underlying AbortController", () => {
		const controller = new ShutdownController();
		expect(controller.signal.aborted).toBe(false);
	});

	it("aborts the signal when abort() is called", () => {
		const controller = new ShutdownController();
		controller.abort();
		expect(controller.signal.aborted).toBe(true);
	});
});
