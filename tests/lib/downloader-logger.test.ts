import type { Job } from "bullmq";
import type pino from "pino";

const setDebugModeMock = jest.fn();

jest.mock(
	"wayback-machine-downloader",
	() => ({
		__esModule: true,
		setDebugMode: setDebugModeMock,
	}),
	{ virtual: true },
);

import {
	installDownloaderLogging,
	runWithDownloaderLogging,
} from "../../src/lib/downloader-logger";

function makeLogger(): pino.Logger & { info: jest.Mock; warn: jest.Mock } {
	return {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
		child: jest.fn(),
	} as unknown as pino.Logger & { info: jest.Mock; warn: jest.Mock };
}

describe("downloader-logger", () => {
	const originalLog = console.log;

	beforeAll(() => {
		installDownloaderLogging();
	});

	afterAll(() => {
		// Restore the original console.log so other test suites are not
		// affected by the global patch.
		console.log = originalLog;
	});

	beforeEach(() => {
		setDebugModeMock.mockClear();
	});

	it("calls setDebugMode(true) once on first install", () => {
		// installDownloaderLogging() ran in beforeAll. Calling it again is
		// a no-op — setDebugMode should not be called a second time.
		installDownloaderLogging();
		expect(setDebugModeMock).not.toHaveBeenCalled();
	});

	it("routes console.log inside the scope to the supplied pino logger", async () => {
		const logger = makeLogger();
		await runWithDownloaderLogging({ logger }, async () => {
			console.log("hello from downloader");
		});
		expect(logger.info).toHaveBeenCalledWith("hello from downloader");
	});

	it("formats multi-argument console.log calls (util.format semantics)", async () => {
		const logger = makeLogger();
		await runWithDownloaderLogging({ logger }, async () => {
			console.log("count:", 7, { ok: true });
		});
		expect(logger.info).toHaveBeenCalledWith("count: 7 { ok: true }");
	});

	it("appends to the BullMQ job log when a job is supplied", async () => {
		const logger = makeLogger();
		const job = { log: jest.fn().mockResolvedValue(1) } as unknown as Job;
		await runWithDownloaderLogging({ logger, job }, async () => {
			console.log("file done: foo.png");
		});
		expect((job as unknown as { log: jest.Mock }).log).toHaveBeenCalledWith("file done: foo.png");
	});

	it("never throws when job.log rejects — surfaces a warn through pino instead", async () => {
		const logger = makeLogger();
		const jobErr = new Error("redis down");
		const job = { log: jest.fn().mockRejectedValue(jobErr) } as unknown as Job;
		await runWithDownloaderLogging({ logger, job }, async () => {
			console.log("file done");
		});
		// Allow the rejected promise's catch handler to run.
		await new Promise((r) => setImmediate(r));
		expect(logger.warn).toHaveBeenCalledWith(
			{ err: "redis down" },
			expect.stringContaining("job.log failed"),
		);
	});

	it("preserves the async context across awaits inside the scope", async () => {
		const logger = makeLogger();
		await runWithDownloaderLogging({ logger }, async () => {
			await Promise.resolve();
			await new Promise((r) => setImmediate(r));
			console.log("after-await");
		});
		expect(logger.info).toHaveBeenCalledWith("after-await");
	});

	it("passes console.log through unchanged when no scope is active", () => {
		const logger = makeLogger();
		const spy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			console.log("plain output");
		} finally {
			spy.mockRestore();
		}
		// Outside the scope the structured logger must NOT receive the call.
		expect(logger.info).not.toHaveBeenCalled();
	});
});
