import { Queue, QueueEvents, type Worker } from "bullmq";
import type IORedis from "ioredis";
import type pino from "pino";
import { ArchiveJobClient } from "../clients/archive-job-client";
import type { Config } from "../models/config";
import { attachQueueLogger, startArchiveWorkers } from "../queue/archive-worker";
import { type DomainCrawlJob, type ExactUrlJob, QUEUE_CRAWL, QUEUE_EXACT } from "../queue/jobs";
import { CacheService } from "../services/cache";
import { ProxyService } from "../services/proxy";
import type { UrlValidatorModule } from "../services/time-machine";
import { createLogger } from "./logger";
import { createRedis } from "./redis";
import { ShutdownController } from "./shutdown";
import { isHostWhitelisted, validateTargetUrl } from "./url-validator";

/**
 * Aggregate of every long-lived runtime resource. TimeMachineService reads
 * `proxy`, `cache`, `validator`, `shutdown`, `logger`; Dependencies.close()
 * owns the rest for orderly shutdown.
 */
export interface DependencyStore {
	logger: pino.Logger;
	shutdown: ShutdownController;
	redis: IORedis;
	exactQueue: Queue<ExactUrlJob>;
	crawlQueue: Queue<DomainCrawlJob>;
	exactEvents: QueueEvents;
	crawlEvents: QueueEvents;
	workers: { exact: Worker; crawl: Worker };
	cache: CacheService;
	archiveJobClient: ArchiveJobClient;
	proxy: ProxyService;
	validator: UrlValidatorModule;
}

/**
 * Constructs the full runtime graph from a Config. Single ioredis connection
 * is shared across both Queues, both QueueEvents, both Workers, and the
 * ProxyService's per-host budget SET NX EX writes.
 *
 * close() ordering is load-bearing:
 *   1. Workers drain (Promise.all) — finishes in-flight jobs, prevents the
 *      "Connection is closed" warnings BullMQ emits when downstream Redis
 *      disconnects mid-processor.
 *   2. Queues + QueueEvents close (Promise.all) — releases blocking BRPOPLPUSH
 *      subscribers cleanly.
 *   3. redis.quit() — graceful QUIT, flushes pending writes.
 */
export class Dependencies {
	private readonly deps: DependencyStore;

	constructor(config: Config) {
		const logger = createLogger();
		const shutdown = new ShutdownController();
		const redis = createRedis(config.redisUrl);

		const exactQueue = new Queue<ExactUrlJob>(QUEUE_EXACT, {
			connection: redis,
			prefix: config.bullmqPrefix,
		});
		const crawlQueue = new Queue<DomainCrawlJob>(QUEUE_CRAWL, {
			connection: redis,
			prefix: config.bullmqPrefix,
		});
		const exactEvents = new QueueEvents(QUEUE_EXACT, {
			connection: redis,
			prefix: config.bullmqPrefix,
		});
		const crawlEvents = new QueueEvents(QUEUE_CRAWL, {
			connection: redis,
			prefix: config.bullmqPrefix,
		});
		attachQueueLogger(QUEUE_EXACT, exactEvents, logger);
		attachQueueLogger(QUEUE_CRAWL, crawlEvents, logger);

		const cache = new CacheService(config, logger);
		// DEFERRED (2026-05-21) — temporary identity resolver. Story 005-a8ed
		// replaces this with the real resolveSnapshotTimestamp closure bound
		// to config.snapshotWindowDays and config.allowLaterFallback.
		const stubResolver = async (_variants: string[], time: string) => time;
		const workers = startArchiveWorkers({
			connection: redis,
			cache,
			resolver: stubResolver,
			logger,
			bullmqPrefix: config.bullmqPrefix,
			workerConcurrency: config.workerConcurrency,
			workerRateLimitPerSec: config.workerRateLimitPerSec,
			downloaderThreadsCount: config.downloaderThreadsCount,
		});
		const archiveJobClient = new ArchiveJobClient(
			exactQueue,
			crawlQueue,
			exactEvents,
			logger,
			config.domainCrawlEnabled,
		);
		const proxy = new ProxyService(cache, archiveJobClient, logger, config, redis);
		const validator: UrlValidatorModule = { validateTargetUrl, isHostWhitelisted };

		this.deps = {
			logger,
			shutdown,
			redis,
			exactQueue,
			crawlQueue,
			exactEvents,
			crawlEvents,
			workers,
			cache,
			archiveJobClient,
			proxy,
			validator,
		};
	}

	get(): DependencyStore {
		return this.deps;
	}

	async close(): Promise<void> {
		const { workers, exactQueue, crawlQueue, exactEvents, crawlEvents, redis } = this.deps;
		// 1. Drain workers first so in-flight jobs complete
		await Promise.all([workers.exact.close(), workers.crawl.close()]);
		// 2. Close queues + events together
		await Promise.all([
			exactQueue.close(),
			crawlQueue.close(),
			exactEvents.close(),
			crawlEvents.close(),
		]);
		// 3. Quit Redis last (graceful QUIT after all subscribers disconnect)
		await redis.quit();
	}
}
