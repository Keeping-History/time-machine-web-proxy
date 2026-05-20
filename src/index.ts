import { WaybackClient } from "./clients/wayback";
import { ensureCacheDir, loadConfig } from "./lib/config";
import { createLogger } from "./lib/logger";
import { ArchiveRequestQueue } from "./lib/queue";
import { ShutdownController } from "./lib/shutdown";
import { isHostWhitelisted, validateTargetUrl } from "./lib/url-validator";
import { CacheService } from "./services/cache";
import { ProxyService } from "./services/proxy";
import { TimeMachineService } from "./services/time-machine";

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
