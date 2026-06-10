import { ShutdownController } from "../../src/lib/shutdown";

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
