import { Queue, QueueEvents, type Worker } from "bullmq";
import type IORedis from "ioredis";
import type pino from "pino";
import { ArchiveJobClient } from "../clients/archive-job-client";
import { DedupingDirectClient } from "../clients/deduping-direct-client";
import { WaybackDirectClient } from "../clients/wayback-direct-client";
import type { Config } from "../models/config";
import type { DirectClientPort } from "../models/direct-client";
import type { SystemStatus } from "../models/status";
import type { UrlValidatorModule } from "../models/url-validator";
import { attachQueueLogger, startArchiveWorkers } from "../queue/archive-worker";
import { type DomainCrawlJob, type ExactUrlJob, QUEUE_CRAWL, QUEUE_EXACT } from "../queue/jobs";
import { CacheService } from "../services/cache";
import { ProxyService } from "../services/proxy";
import { BlocklistService } from "./blocklist";
import { createLogger } from "./logger";
import type { RotatingProxyDispatcher } from "./outbound-proxy";
import { createRedis } from "./redis";
import { ShutdownController } from "./shutdown";
import { isHostWhitelisted, validateTargetUrl } from "./url-validator";

/** Minimal interface shared by the real DedupingDirectClient and the passthrough stub. */
export type DirectClient = DirectClientPort;

/** Passthrough stub used when DIRECT_FETCH_ENABLED=false. */
const passthroughDirectClient: DirectClient = {
	fetchAtResolvedTime: async () => ({ outcome: "fallback" as const }),
	fetchAtRequestedTime: async () => ({ outcome: "fallback" as const }),
};

/**
 * Builds the appropriate DirectClient for the given config.
 * When directFetchEnabled is false, returns a passthrough that always yields
 * `{ outcome: 'fallback' }` without touching the network.
 */
export function buildDirectClient(config: Config, logger: pino.Logger): DirectClient {
	if (!config.directFetchEnabled) {
		logger.info("[direct] direct-fetch disabled — using passthrough stub");
		return passthroughDirectClient;
	}
	const inner = new WaybackDirectClient({
		ratePerSecond: config.directFetchRatePerSec,
		burst: config.directFetchBurst,
		timeoutMs: config.directFetchTimeoutMs,
		breakerBaseMs: config.directFetchBlockedBaseMs,
		breakerMaxMs: config.directFetchBlockedMaxMs,
		logger,
	});
	return new DedupingDirectClient(inner, {
		maxConcurrency: config.directFetchMaxConcurrent,
	});
}

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
	private readonly outboundProxy: RotatingProxyDispatcher | null;

	constructor(config: Config, outboundProxy: RotatingProxyDispatcher | null = null) {
		this.outboundProxy = outboundProxy;
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

		const directClient = buildDirectClient(config, logger);
		const archiveJobClient = new ArchiveJobClient(
			exactQueue,
			crawlQueue,
			exactEvents,
			logger,
			config.domainCrawlEnabled,
		);
		const workers = startArchiveWorkers({
			connection: redis,
			cache,
			directClient,
			enqueueExactJob: (url, time, crawl) => archiveJobClient.enqueueExact(url, time, crawl),
			logger,
			bullmqPrefix: config.bullmqPrefix,
			workerConcurrency: config.workerConcurrency,
			workerRateLimitPerSec: config.workerRateLimitPerSec,
			redis,
			crawlMaxDepth: config.crawlMaxDepth,
			crawlMaxPages: config.crawlMaxPages,
		});
		const blocklist = new BlocklistService(config.cacheDir, logger);
		const proxy = new ProxyService(
			cache,
			archiveJobClient,
			logger,
			config,
			redis,
			directClient,
			blocklist,
		);
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

	/**
	 * Aggregated operational status for the /status endpoint. All probes are
	 * read-only and tolerate partial failures: each section is best-effort so
	 * an unhealthy queue can't mask the rest of the report.
	 */
	async getStatus(): Promise<SystemStatus> {
		const { redis, exactQueue, crawlQueue, logger } = this.deps;
		const [exactCounts, crawlCounts] = await Promise.all([
			safeJobCounts(exactQueue, logger),
			safeJobCounts(crawlQueue, logger),
		]);
		return {
			redis: { status: (redis as IORedis & { status?: string }).status ?? "unknown" },
			outboundProxies: {
				configured: this.outboundProxy !== null,
				agents: this.outboundProxy?.getStatus() ?? [],
			},
			queues: {
				[QUEUE_EXACT]: exactCounts,
				[QUEUE_CRAWL]: crawlCounts,
			},
		};
	}

	async close(): Promise<void> {
		const { workers, exactQueue, crawlQueue, exactEvents, crawlEvents, redis, proxy } = this.deps;
		// 1. Drain workers first so in-flight jobs complete
		await Promise.all([workers.exact.close(), workers.crawl.close()]);
		// 2. Close queues + events together
		await Promise.all([
			exactQueue.close(),
			crawlQueue.close(),
			exactEvents.close(),
			crawlEvents.close(),
		]);
		// 3. Await any in-flight prewarm promises before closing Redis
		await proxy.drainPrewarms();
		// 4. Quit Redis last (graceful QUIT after all subscribers disconnect)
		try {
			await redis.quit();
		} catch (err) {
			this.deps.logger.warn({ err }, "[deps] redis.quit error during shutdown");
		}
	}
}

/**
 * BullMQ's `getJobCounts()` resolves a string-keyed object including any
 * states we request. We always ask for the standard five so the response
 * shape is stable. A queue that's mid-shutdown or whose Redis is down may
 * reject — we surface zeros rather than 500'ing the whole /status call.
 */
async function safeJobCounts<T>(queue: Queue<T>, logger: pino.Logger): Promise<SystemStatus["queues"][string]> {
	try {
		const counts = await queue.getJobCounts("failed", "waiting", "active", "completed", "delayed");
		return {
			failed: counts.failed ?? 0,
			waiting: counts.waiting ?? 0,
			active: counts.active ?? 0,
			completed: counts.completed ?? 0,
			delayed: counts.delayed ?? 0,
		};
	} catch (err) {
		logger.warn({ err }, "[deps] safeJobCounts Redis error");
		return { failed: 0, waiting: 0, active: 0, completed: 0, delayed: 0 };
	}
}
