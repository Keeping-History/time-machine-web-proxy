import { createLogger } from "../../src/lib/logger";

describe("createLogger", () => {
	it("defaults to info level when LOG_LEVEL is not set", () => {
		delete process.env.LOG_LEVEL;
		const logger = createLogger();
		expect(logger.level).toBe("info");
	});

	it("uses LOG_LEVEL env var when set", () => {
		process.env.LOG_LEVEL = "debug";
		const logger = createLogger();
		expect(logger.level).toBe("debug");
		delete process.env.LOG_LEVEL;
	});

	it("suppresses debug output at info level", () => {
		const logger = createLogger({ level: "info" });
		expect(logger.isLevelEnabled("debug")).toBe(false);
		expect(logger.isLevelEnabled("info")).toBe(true);
	});

	it("enables debug output at debug level", () => {
		const logger = createLogger({ level: "debug" });
		expect(logger.isLevelEnabled("debug")).toBe(true);
	});

	it("accepts an explicit level overriding LOG_LEVEL", () => {
		process.env.LOG_LEVEL = "error";
		const logger = createLogger({ level: "warn" });
		expect(logger.level).toBe("warn");
		delete process.env.LOG_LEVEL;
	});
});
