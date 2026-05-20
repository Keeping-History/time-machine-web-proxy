import type pino from "pino";
import type { ArchiveJobClientPort } from "../clients/archive-job-client";
import { WaybackClient } from "../clients/wayback";
import type { Config } from "../models/config";
import { CacheService } from "../services/cache";
import { ProxyService } from "../services/proxy";
import type { UrlValidatorModule } from "../services/time-machine";
import { createLogger } from "./logger";
import { ArchiveRequestQueue } from "./queue";
import { ShutdownController } from "./shutdown";
import { isHostWhitelisted, validateTargetUrl } from "./url-validator";

export interface DependencyStore {
	logger: pino.Logger;
	shutdown: ShutdownController;
	queue: ArchiveRequestQueue;
	wayback: WaybackClient;
	cache: CacheService;
	proxy: ProxyService;
	validator: UrlValidatorModule;
}

/**
 * Interim ArchiveJobClient stub. TASK-010 replaces this with the real
 * BullMQ-backed client wired to Redis + queues + workers + QueueEvents.
 * Until then any attempt to actually USE the proxy at runtime will throw
 * — but tests that mock the proxy entirely are unaffected, and typecheck
 * still passes because the stub satisfies ArchiveJobClientPort.
 */
class StubArchiveJobClient implements ArchiveJobClientPort {
	async enqueueExactAndWait(): Promise<void> {
		throw new Error("ArchiveJobClient not wired — TASK-010 pending");
	}
	async enqueueDomainCrawl(): Promise<void> {
		throw new Error("ArchiveJobClient not wired — TASK-010 pending");
	}
}

export class Dependencies {
	private readonly deps: DependencyStore;

	constructor(config: Config) {
		const { archiveMaxConcurrent, archiveRatePerSec, archiveBurst } = config;
		const logger = createLogger();
		const shutdown = new ShutdownController();
		const queue = new ArchiveRequestQueue(archiveMaxConcurrent, archiveRatePerSec, archiveBurst);
		const wayback = new WaybackClient(queue, shutdown, logger, config);
		const cache = new CacheService(config, logger);
		// TODO(TASK-010): wire real ArchiveJobClient with Redis/queues/QueueEvents.
		const archiveJobClient = new StubArchiveJobClient();
		const proxy = new ProxyService(cache, archiveJobClient, logger, config);
		const validator: UrlValidatorModule = { validateTargetUrl, isHostWhitelisted };
		this.deps = { logger, shutdown, queue, wayback, cache, proxy, validator };
	}

	get(): DependencyStore {
		return this.deps;
	}
}
