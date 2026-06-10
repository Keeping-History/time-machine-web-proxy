import pino from "pino";
import { installProcessErrorHandlers } from "../../src/lib/process-error-handlers";

// Each test installs handlers on the real `process` and tears them down via
// process.removeAllListeners — sharing the global between tests would leak
// listeners and trip Node's MaxListenersExceededWarning in a long suite.
describe("installProcessErrorHandlers", () => {
	const realExit = process.exit;
	let exitSpy: jest.Mock;

	beforeEach(() => {
		process.removeAllListeners("unhandledRejection");
		process.removeAllListeners("uncaughtException");
		exitSpy = jest.fn();
		// Cast through unknown so the noop honours the (never)-returning signature
		// without requiring the spy itself to be `never`-typed.
		process.exit = exitSpy as unknown as typeof process.exit;
	});

	afterEach(() => {
		process.removeAllListeners("unhandledRejection");
		process.removeAllListeners("uncaughtException");
		process.exit = realExit;
	});

	it("registers an unhandledRejection listener", () => {
		const logger = pino({ level: "silent" });
		installProcessErrorHandlers(logger);
		expect(process.listenerCount("unhandledRejection")).toBe(1);
	});

	it("registers an uncaughtException listener", () => {
		const logger = pino({ level: "silent" });
		installProcessErrorHandlers(logger);
		expect(process.listenerCount("uncaughtException")).toBe(1);
	});

	it("unhandledRejection handler logs via pino and exits 1", () => {
		const logged: unknown[] = [];
		const logger = pino({ level: "fatal" }, {
			write: (chunk: string): void => {
				logged.push(JSON.parse(chunk));
			},
		});
		installProcessErrorHandlers(logger);

		process.emit("unhandledRejection", new Error("boom"), Promise.resolve());

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logged).toHaveLength(1);
		const entry = logged[0] as { level: number; err?: { message?: string } };
		// pino level 60 = fatal
		expect(entry.level).toBe(60);
		expect(entry.err?.message).toBe("boom");
	});

	it("uncaughtException handler logs via pino and exits 1", () => {
		const logged: unknown[] = [];
		const logger = pino({ level: "fatal" }, {
			write: (chunk: string): void => {
				logged.push(JSON.parse(chunk));
			},
		});
		installProcessErrorHandlers(logger);

		process.emit("uncaughtException", new Error("kaboom"));

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logged).toHaveLength(1);
		const entry = logged[0] as { level: number; err?: { message?: string } };
		expect(entry.level).toBe(60);
		expect(entry.err?.message).toBe("kaboom");
	});

	// Promise rejections frequently carry non-Error reasons (string,
	// undefined, structured object). The handler must not crash on these and
	// must still exit — otherwise we lose the diagnostic line we installed
	// the handler for in the first place.
	it("unhandledRejection handler tolerates non-Error reasons", () => {
		const logger = pino({ level: "silent" });
		installProcessErrorHandlers(logger);

		process.emit("unhandledRejection", "string reason", Promise.resolve());

		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
