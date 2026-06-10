import type pino from "pino";

/**
 * Installs process-wide handlers for `unhandledRejection` and
 * `uncaughtException`. Both log via pino at fatal level then call
 * `process.exit(1)` — escaped errors otherwise crash Node with no
 * diagnostic line, and Cloud Run containers exit without a trace.
 *
 * Call this once at process boot, BEFORE the application's `main()`
 * begins doing async work, so a rejection from prewarm, ws events,
 * or timer callbacks always lands in a handler.
 */
export function installProcessErrorHandlers(logger: pino.Logger): void {
	process.on("unhandledRejection", (reason: unknown): void => {
		// `reason` is `unknown` by spec — pino's err serializer needs an Error
		// to extract message/stack, so wrap primitives/strings in one.
		const err = reason instanceof Error ? reason : new Error(String(reason));
		logger.fatal({ err }, "[process] unhandledRejection — exiting 1");
		process.exit(1);
	});

	process.on("uncaughtException", (err: Error): void => {
		logger.fatal({ err }, "[process] uncaughtException — exiting 1");
		process.exit(1);
	});
}
