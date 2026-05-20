import { loadConfig, ensureCacheDir } from "./lib/config";
import { createLogger } from "./lib/logger";
import { ShutdownController } from "./lib/shutdown";
import { ArchiveRequestQueue } from "./lib/queue";
import { WaybackClient } from "./clients/wayback";
import { CacheService } from "./services/cache";
import { ProxyService } from "./services/proxy";
import { TimeMachineService } from "./services/time-machine";
import { validateTargetUrl, isHostWhitelisted } from "./lib/url-validator";

const config = loadConfig();
ensureCacheDir(config.cacheDir);

const logger = createLogger();
const shutdown = new ShutdownController();
const queue = new ArchiveRequestQueue(
	config.archiveMaxConcurrent,
	config.archiveRatePerSec,
	config.archiveBurst,
);
const wayback = new WaybackClient(queue, shutdown, logger, config);
const cache = new CacheService(config, logger);
const proxy = new ProxyService(cache, wayback, logger, config);
const validator = { validateTargetUrl, isHostWhitelisted };
const service = new TimeMachineService(config, proxy, cache, validator, shutdown, logger);

service.start();
