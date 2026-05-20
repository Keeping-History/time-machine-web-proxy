import type pino from "pino";
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

export class Dependencies {
	private readonly deps: DependencyStore;

	constructor(config: Config) {
		const { archiveMaxConcurrent, archiveRatePerSec, archiveBurst } = config;
		const logger = createLogger();
		const shutdown = new ShutdownController();
		const queue = new ArchiveRequestQueue(archiveMaxConcurrent, archiveRatePerSec, archiveBurst);
		const wayback = new WaybackClient(queue, shutdown, logger, config);
		const cache = new CacheService(config, logger);
		const proxy = new ProxyService(cache, wayback, logger, config);
		const validator: UrlValidatorModule = { validateTargetUrl, isHostWhitelisted };
		this.deps = { logger, shutdown, queue, wayback, cache, proxy, validator };
	}

	get(): DependencyStore {
		return this.deps;
	}
}
