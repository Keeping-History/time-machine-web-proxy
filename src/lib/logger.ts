import pino from "pino";

interface LoggerOptions {
	level?: string;
}

export function createLogger(options?: LoggerOptions): pino.Logger {
	const level = options?.level ?? process.env.LOG_LEVEL ?? "info";
	return pino({ level });
}

export const logger = createLogger();
