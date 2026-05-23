import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import type { Job } from "bullmq";
import type pino from "pino";
import { setDebugMode } from "wayback-machine-downloader";

export interface DownloaderLogContext {
	logger: pino.Logger;
	job?: Job;
}

const ctx = new AsyncLocalStorage<DownloaderLogContext>();
let installed = false;

/**
 * One-time install: flips the downloader into debug mode and patches
 * `console.log` so any debugLog/infoLog output emitted during a
 * `runWithDownloaderLogging(...)` scope is routed to a structured pino
 * logger (and optionally appended to a BullMQ job's log so bull-board
 * surfaces it).
 *
 * `wayback-machine-downloader@0.5.0` has no progress/log hooks — its
 * loggers call `console.log` directly. ESM bindings cannot be
 * reassigned from outside the package, so a `console.log` patch is the
 * only mechanism. AsyncLocalStorage scopes the patch to in-flight
 * downloader calls; anything else passes through to the original
 * `console.log` unchanged.
 */
export function installDownloaderLogging(): void {
	if (installed) return;
	installed = true;
	setDebugMode(true);
	const originalLog = console.log.bind(console);
	console.log = (...args: unknown[]): void => {
		const store = ctx.getStore();
		if (!store) {
			originalLog(...args);
			return;
		}
		const msg = format(...args);
		store.logger.info(msg);
		// Per-job log writes are observability, not correctness — never
		// allow a Redis hiccup to break the in-flight download. Route the
		// failure through pino instead of `console.log` to avoid recursing
		// back into this patch.
		store.job?.log(msg).catch((e: unknown) => {
			store.logger.warn(
				{ err: e instanceof Error ? e.message : String(e) },
				"[downloader-logger] job.log failed",
			);
		});
	};
}

/**
 * Run `fn` with the supplied downloader log context active. Any
 * `console.log` emitted by the downloader (or by code it awaits) is
 * routed via the context's pino logger and, when present, appended to
 * the BullMQ job's log buffer.
 */
export function runWithDownloaderLogging<T>(
	context: DownloaderLogContext,
	fn: () => Promise<T>,
): Promise<T> {
	return ctx.run(context, fn);
}
