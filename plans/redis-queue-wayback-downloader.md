---
status: approved
approved_at: "2026-05-20T17:11:01.824Z"
updated: "2026-05-20T17:11:01.825Z"
---
# Plan: Redis-Queued Wayback Downloader Refactor

**Created:** 2026-05-20 | **Status:** Draft | **Effort:** L | **Branch:** wip/modular-refactor-pnpm-turborepo

## Summary

Replace the hand-rolled `WaybackClient` + in-process `ArchiveRequestQueue` with the npm package `wayback-machine-downloader@0.5.0` wrapped in a BullMQ + ioredis job queue backed by Cloud Memorystore. User requests enqueue an `exact-url` job, wait for completion, then fire a fire-and-forget `domain-crawl` job. Cache format is replaced with a filesystem-tree layout matching the downloader's native output (existing cache invalidated, no migration). Supersedes `plans/multi-archive-memento-refactor.md`.

## Architecture Context

- Foreground flow today: `httpHandler` → `ProxyService.fetch` → `cache.get` → on miss: `arcUrl()` + `WaybackClient.fetch` → `stripWaybackToolbar` + URL rewrite → cache write → response (`src/services/time-machine.ts:99`, `src/services/proxy.ts:26`, `src/clients/wayback.ts:65`).
- The gap is the wayback fetch path itself: `WaybackClient` becomes a thin **producer** that enqueues a BullMQ job and `await`s its completion via `QueueEvents`. The actual HTTP + disk write happens in a **Worker** process (same Node.js process, separate BullMQ queue).
- Key files (roles, not just paths):
  - `src/clients/wayback.ts` — to be deleted; replaced by `src/clients/archive-job-client.ts` (enqueue + await).
  - `src/lib/queue.ts` — to be deleted; BullMQ replaces it.
  - `src/services/cache.ts` — fully rewritten for tree layout; old SHA256+JSON gone.
  - `src/services/proxy.ts:42` — `arcUrl(...)` call site changes; `stripWaybackToolbar` kept as defensive layer because package may not always emit `id_` modifier.
  - `src/lib/dependencies.ts` — adds Redis connection, queue, worker, queueEvents; `wayback` field renamed to `archiveJobClient`.
- The downloader package writes to disk. The cache layer reads back from disk. URL rewriting runs at cache-read time, not cache-write time, because the downloader emits multiple files per crawl.

## Research Findings

- `wayback-machine-downloader@0.5.0` (npm, ESM, MIT, Node 18+, no types). Maintainer `sigman78`, author `birbwatcher`, pre-1.0, single-author bus factor 1. Tarball integrity: `sha512-iY5SvDfz3VVSrIriVSKEvFZ1dnsas4v9WsN/cejv3sCdGMbd1e0Z+5/PpsyDx5ypc9ARswMtEuY7pDyBRpgg4Q==`.
- Programmatic API: `new WaybackMachineDownloader({ base_url, normalized_base, from_timestamp, to_timestamp, threads_count, rewrite_mode, canonical_action, exact_url, download_external_assets, directory }).download_files()`.
- `exact_url: true` + `from_timestamp = to_timestamp = <time>` maps to "fetch this one URL at this one snapshot." `exact_url: false` is the wildcard domain crawl.
- Package lacks: TypeScript types, retry on 429/503, exponential backoff, AbortSignal support, in-memory return. All retry/backoff must live in BullMQ job config.
- BullMQ v5+ is the only viable Node.js queue for long-running scrape jobs in 2026 (Bull EOL, Bee-Queue lacks priorities/scheduling). Requires `ioredis` with `maxRetriesPerRequest: null, enableReadyCheck: false`.
- Cloud Memorystore for Redis Basic 1GB ~$36/mo, reachable from Cloud Run only via Serverless VPC Connector (additional ~$10/mo for the smallest instance).
- Supersedes `plans/multi-archive-memento-refactor.md` (approved 2026-05-20, no implementation work started). Move to `plans/archive/` in Step 0.

## Security Considerations

- **SSRF guard moves from client to producer:** validate `url.startsWith("https://web.archive.org/")` **before** enqueue. Reject early to keep poisoned payloads out of Redis.
- **Job payload validation:** every worker reads `{ url, time }` from Redis. Validate `time` matches `/^\d{14}$/` and `url` is `http(s):` before passing to the downloader. Treat Redis as untrusted (multi-tenant Memorystore risk).
- **Path traversal in cache reads:** the downloader writes files at paths derived from URLs. Sanitize: cache reads MUST resolve `path.join(root, host, ...)` then check `resolved.startsWith(root + path.sep + host + path.sep)`. Reject otherwise.
- **Redis AUTH:** Memorystore Basic supports AUTH (off by default). Enable AUTH and store password in Secret Manager; inject as `REDIS_PASSWORD` env via `--set-secrets`.
- **Domain crawl scope:** an attacker passing `evil.com` triggers an unbounded crawl. Apply existing `WHITELIST_HOSTS` to the domain-crawl enqueue, not just to the foreground URL.

## Performance Considerations

- Foreground latency: cold path adds Redis round-trip (~1-3ms in-VPC) + BullMQ scheduling (~5-10ms) + downloader exec time. Negligible overhead vs. existing wayback fetch (~1-30s).
- Memorystore + Cloud Run cold start: VPC Connector cold-start ~2-5s; mitigate with `--min-instances=1` on the connector. Plan as a config concern, not a code concern.
- Cache reads stay synchronous filesystem walks (GCS FUSE). No new IPC.
- Domain crawl jobs may write thousands of files. Cap `threads_count: 3` per job and `concurrency: 2` at worker level — same effective rate as today's `ARCHIVE_MAX_CONCURRENT=10` but distributed across BullMQ workers.
- Rate-limit Wayback at the worker (`limiter: { max: 2, duration: 1000 }` = 2 jobs/sec, matches existing `ARCHIVE_RATE_PER_SEC=2`).

### Research Enhancement

- **GCS FUSE close-to-open consistency clarification:** `download_files()` resolves only after FUSE closes each file (streaming writes upload to GCS during write, close finalizes). Same-instance reads via `fs.access(path)` see the file immediately. Cross-instance reads also see the object — GCS provides strong read-after-write for new objects; only `fs.readdir` is subject to the kernel list-cache TTL. The current `cache.lookup` uses `fs.access`, not `readdir` — no `fsync` or sleep-retry needed. Source: [GCS FUSE semantics.md](https://github.com/GoogleCloudPlatform/gcsfuse/blob/master/docs/semantics.md).
- **Wayback rate-limit reality (2026):** CDX API now blocks IPs exceeding 60 req/min for over a minute; block duration doubles on repeated violations. The worker's `limiter: { max: 2, duration: 1000 }` = 120 req/min is **above** the safe ceiling. Recommend `max: 1` (60 req/min) for safety, or `max: 2` with a circuit-breaker fallback. Source: [Web Archive 2026 rate limits](https://archivarix.com/en/blog/webarchive-2026/).
- **Ref:** best-practices-researcher (GCS FUSE + Wayback rate-limit research).

## Decisions Captured From Clarification

1. Package = `wayback-machine-downloader@0.5.0` (npm). Pin to tarball URL for integrity stability: `pnpm add https://registry.npmjs.org/wayback-machine-downloader/-/wayback-machine-downloader-0.5.0.tgz`.
2. Multi-archive plan superseded — single archive (Wayback) only.
3. Redis = Cloud Memorystore Basic 1GB + Serverless VPC Connector. Code reads `REDIS_URL` env var; infra setup is a deployment story, not in this plan's code steps.
4. Foreground request blocks on job completion. Background domain crawl is fire-and-forget.

## Steps

### Step 0: Archive superseded plan
- **Implement:** `git mv plans/multi-archive-memento-refactor.md plans/archive/`. Add note at top of archived file: `Superseded by plans/redis-queue-wayback-downloader.md (2026-05-20)`.
- **Validation:** `ls plans/multi-archive-memento-refactor.md` → file not found.

### Step 1: Dependencies + type declaration
- **Test:** `tests/types/wayback-machine-downloader.test-d.ts` — type-only test asserting `new WaybackMachineDownloader({ base_url: "x", from_timestamp: 0, to_timestamp: 0, threads_count: 3, rewrite_mode: "as-is", canonical_action: "keep", exact_url: true, download_external_assets: false, directory: "/tmp" }).download_files() returns Promise<void>`.
- **Implement:** `pnpm add https://registry.npmjs.org/wayback-machine-downloader/-/wayback-machine-downloader-0.5.0.tgz bullmq ioredis`. Add `src/types/wayback-machine-downloader.d.ts`:
- **Code:**
  ```ts
  declare module "wayback-machine-downloader" {
    export interface DownloaderOptions {
      base_url: string;
      normalized_base?: { canonicalUrl: string; host: string };
      from_timestamp: number | string;
      to_timestamp: number | string;
      threads_count: number;
      rewrite_mode: "as-is" | "relative";
      canonical_action: "keep" | "remove";
      exact_url: boolean;
      download_external_assets: boolean;
      directory: string | null;
    }
    export class WaybackMachineDownloader {
      constructor(opts: DownloaderOptions);
      download_files(): Promise<void>;
    }
    export function setDebugMode(on: boolean): void;
  }
  declare module "wayback-machine-downloader/lib/utils.js" {
    export function normalizeBaseUrlInput(input: string): { canonicalUrl: string; host: string };
  }
  ```
- **Validation:** `pnpm typecheck`.

### Research Enhancement

- **Bug fix (verified against tarball source `lib/utils.js:80-85`):** `normalizeBaseUrlInput` returns `{ canonicalUrl, variants, bareHost, unicodeHost }` — **not** `{ canonicalUrl, host }`. The current type declaration AND the Worker code in Step 6 that uses `base.host` will produce `undefined` at runtime. Correct the declaration:
  ```ts
  export function normalizeBaseUrlInput(input: string): {
    canonicalUrl: string; variants: string[]; bareHost: string; unicodeHost: string;
  };
  ```
- **API surface note:** `wayback-machine-downloader/lib/utils.js` is reachable on the filesystem but **not** in the package's `exports` field; strict ESM resolvers may break. Pinning to `0.5.0` mitigates near-term, but log a follow-up to upstream the missing export (or re-export from our `.d.ts` shim).
- **`id_` modifier verified used:** Downloader fetches via `https://web.archive.org/web/${ts}id_/${url}` (tarball `lib/downloader.js:166`). This means `stripWaybackToolbar` is redundant for downloader output — keep it only for legacy cache rows (none in v2) or remove.
- **Ref:** framework-docs-researcher (tarball inspection), `wayback-machine-downloader@0.5.0` source.

### Step 2: Redis connection factory
- **Test:** `tests/lib/redis.test.ts` — `createRedis({ url: "redis://localhost:6379" })` returns an `IORedis` with `maxRetriesPerRequest === null` and `enableReadyCheck === false`. Mock IORedis constructor; assert options.
- **Implement:** `src/lib/redis.ts`.
- **Code:**
  ```ts
  import IORedis from "ioredis";
  export function createRedis(url: string): IORedis {
    return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
  }
  ```
- **Constraint:** `maxRetriesPerRequest: null` is required by BullMQ — without it, blocking commands throw.
- **Validation:** `pnpm test -- tests/lib/redis.test.ts`.

### Step 3: Config — add Redis + queue knobs, remove queue knobs
- **Test:** Update `tests/lib/config.test.ts` — `REDIS_URL` defaults to `redis://localhost:6379`; `BULLMQ_PREFIX` defaults to `tm`; `DOMAIN_CRAWL_ENABLED` defaults `true`; `WORKER_CONCURRENCY` defaults `2`; assert `archiveRatePerSec/Burst/MaxConcurrent` removed from `Config`.
- **Implement:** `src/lib/config.ts` + `src/models/config.ts`. Add `redisUrl`, `bullmqPrefix`, `domainCrawlEnabled`, `workerConcurrency`, `workerRateLimitPerSec`, `downloaderThreadsCount`. Drop `archivePrefix` (always Wayback now), `archiveRatePerSec`, `archiveBurst`, `archiveMaxRetries`, `archiveMaxConcurrent` (BullMQ owns rate/retry).
- **Code:**
  ```ts
  export interface Config {
    port: number; hostname: string; defaultTime: string;
    cacheDir: string; cacheEnabled: boolean;
    allowedOrigins: string[]; whitelistHosts: string;
    proxyPrefix: string; proxyBase: string; proxyBaseHostname: string;
    cacheClearToken: string; wsKeepaliveMs: number;
    redisUrl: string;
    bullmqPrefix: string;
    domainCrawlEnabled: boolean;
    workerConcurrency: number;
    workerRateLimitPerSec: number;
    downloaderThreadsCount: number;
  }
  ```
- **Validation:** `pnpm test -- tests/lib/config.test.ts && pnpm typecheck`.

### Step 4: Cache layer — filesystem-tree layout
- **Test:** `tests/services/cache.test.ts` — `cache.lookup("https://example.com/about", "20200101000000")` resolves to `${cacheDir}/v2/20200101000000/example.com/about` (or `.../about/index.html` if directory). `cache.exists()` returns false for absent path; true after `mkdir -p` + write. Path-traversal: `lookup("https://example.com/../etc/passwd", ...)` throws. `handleCacheClear` removes only entries under `${cacheDir}/v2/`.
- **Implement:** `src/services/cache.ts`. Drop SHA256+JSON. New shape: `lookup(url, time): Promise<CacheHit | null>` where `CacheHit = { absPath: string; contentType: string; }`. Content-type derived from file extension via `mime-types`. `cacheDirForJob(time, host): string` returns the directory the downloader writes into.
- **Code:**
  ```ts
  import { lookup as mimeLookup } from "mime-types";
  import { resolve, join, sep, extname } from "node:path";
  import { promises as fs } from "node:fs";

  const ROOT_VERSION = "v2";

  export interface CacheHit { absPath: string; contentType: string; }

  export class CacheService {
    constructor(private readonly cfg: Pick<Config, "cacheDir" | "cacheEnabled">) {}

    cacheDirForJob(time: string, host: string): string {
      return join(this.cfg.cacheDir, ROOT_VERSION, time, host);
    }

    async lookup(url: string, time: string): Promise<CacheHit | null> {
      if (!this.cfg.cacheEnabled) return null;
      const u = new URL(url);
      const root = this.cacheDirForJob(time, u.hostname);
      const rel = u.pathname === "/" || u.pathname.endsWith("/")
        ? join(u.pathname, "index.html") : u.pathname;
      const abs = resolve(root, "." + rel);
      if (!abs.startsWith(root + sep) && abs !== root) {
        throw Object.assign(new Error("Path traversal rejected"), { status: 400 });
      }
      try {
        await fs.access(abs);
        const contentType = mimeLookup(extname(abs)) || "application/octet-stream";
        return { absPath: abs, contentType };
      } catch { return null; }
    }
  }
  ```
- **Constraint:** Reads only — no writes. The downloader is the writer. Cache eviction = `rm -rf ${cacheDir}/v2/${time}/${host}`.
- **Validation:** `pnpm test -- tests/services/cache.test.ts`.

### Step 5: Job payloads + queue names
- **Test:** `tests/queue/jobs.test.ts` — schema validation: `ExactUrlJob` requires `url` and `time` (14 digits); `DomainCrawlJob` requires `host` and `time`. Invalid inputs throw.
- **Implement:** `src/queue/jobs.ts`. Use `zod`-free runtime guards (no new dep — match existing `isCacheEntry` style).
- **Code:**
  ```ts
  export const QUEUE_EXACT = "archive:exact";
  export const QUEUE_CRAWL = "archive:crawl";
  export interface ExactUrlJob { url: string; time: string; }
  export interface DomainCrawlJob { host: string; time: string; }
  const TIME_RE = /^\d{14}$/;
  export function assertExactUrlJob(v: unknown): asserts v is ExactUrlJob {
    if (!v || typeof v !== "object") throw new Error("Invalid job: not object");
    const o = v as Record<string, unknown>;
    if (typeof o.url !== "string" || !/^https?:\/\//.test(o.url)) throw new Error("Invalid job.url");
    if (typeof o.time !== "string" || !TIME_RE.test(o.time)) throw new Error("Invalid job.time");
  }
  export function assertDomainCrawlJob(v: unknown): asserts v is DomainCrawlJob {
    if (!v || typeof v !== "object") throw new Error("Invalid job: not object");
    const o = v as Record<string, unknown>;
    if (typeof o.host !== "string" || o.host.length === 0) throw new Error("Invalid job.host");
    if (typeof o.time !== "string" || !TIME_RE.test(o.time)) throw new Error("Invalid job.time");
  }
  ```
- **Validation:** `pnpm test -- tests/queue/jobs.test.ts`.

### Step 6: Archive worker (single process)
- **Test:** `tests/queue/archive-worker.test.ts` — feed an `ExactUrlJob`, mock `WaybackMachineDownloader.prototype.download_files` to resolve; assert the constructor was called with `exact_url: true, from_timestamp: "20200101000000", to_timestamp: "20200101000000", directory: <cache dir for job>`. Feed a `DomainCrawlJob`; assert `exact_url: false`. On thrown error, assert BullMQ retries (test via `attemptsMade` counter mock).
- **Implement:** `src/queue/archive-worker.ts`. Two `Worker` instances, one per queue, sharing the Redis connection. Concurrency from `cfg.workerConcurrency`, rate limit from `cfg.workerRateLimitPerSec`.
- **Code:**
  ```ts
  import { Worker } from "bullmq";
  import { WaybackMachineDownloader } from "wayback-machine-downloader";
  import { normalizeBaseUrlInput } from "wayback-machine-downloader/lib/utils.js";
  import { QUEUE_EXACT, QUEUE_CRAWL, assertExactUrlJob, assertDomainCrawlJob } from "./jobs";

  export function startArchiveWorkers(opts: {
    connection: IORedis; cache: CacheService; logger: pino.Logger;
    workerConcurrency: number; workerRateLimitPerSec: number; downloaderThreadsCount: number;
  }): { exact: Worker; crawl: Worker } {
    const { connection, cache, logger, workerConcurrency, workerRateLimitPerSec, downloaderThreadsCount } = opts;
    const limiter = { max: workerRateLimitPerSec, duration: 1000 };

    const exact = new Worker(QUEUE_EXACT, async (job) => {
      assertExactUrlJob(job.data);
      const { url, time } = job.data;
      const base = normalizeBaseUrlInput(url);
      const directory = cache.cacheDirForJob(time, base.host);
      logger.info({ url, time, directory }, "[worker:exact] start");
      await new WaybackMachineDownloader({
        base_url: base.canonicalUrl, normalized_base: base,
        from_timestamp: time, to_timestamp: time,
        threads_count: downloaderThreadsCount,
        rewrite_mode: "as-is", canonical_action: "keep",
        exact_url: true, download_external_assets: false, directory,
      }).download_files();
    }, { connection, concurrency: workerConcurrency, limiter });

    const crawl = new Worker(QUEUE_CRAWL, async (job) => {
      assertDomainCrawlJob(job.data);
      const { host, time } = job.data;
      const base = normalizeBaseUrlInput(`https://${host}`);
      const directory = cache.cacheDirForJob(time, host);
      logger.info({ host, time, directory }, "[worker:crawl] start");
      await new WaybackMachineDownloader({
        base_url: base.canonicalUrl, normalized_base: base,
        from_timestamp: time, to_timestamp: time,
        threads_count: downloaderThreadsCount,
        rewrite_mode: "as-is", canonical_action: "keep",
        exact_url: false, download_external_assets: false, directory,
      }).download_files();
    }, { connection, concurrency: 1, limiter });

    return { exact, crawl };
  }
  ```
- **Constraint:** Workers don't catch errors — BullMQ retries on throw. Job-level config (Step 7) sets `attempts: 5, backoff: exponential(1000)`.
- **Constraint:** `concurrency: 1` for crawl queue — one full-domain crawl at a time per worker process; foreground (exact) gets the parallelism budget.
- **Validation:** `pnpm test -- tests/queue/archive-worker.test.ts`.

### Research Enhancement

- **CRITICAL BUG (Worker prefix missing):** Both `new Worker(...)` calls omit `prefix`. The default Worker prefix is `"bull"`, so Workers will look for jobs at `bull:archive:exact:wait` while Queues (Step 9) write to `tm:archive:exact:wait`. **Jobs will never dequeue.** Add `prefix: opts.bullmqPrefix` to `workerOpts` and thread `bullmqPrefix` through `startArchiveWorkers` opts. Source: [BullMQ issue #424](https://github.com/taskforcesh/bullmq/issues/424).
- **CRITICAL BUG (runtime):** `base.host` does not exist on `normalizeBaseUrlInput`'s return type — must be `base.bareHost` (see Step 1 enhancement). Two sites in this code.
- **`lockDuration` + `extendLock` for crawl worker:** Default `lockDuration: 30_000` will stall on a 5-10 min crawl. BullMQ re-queues stalled jobs → duplicate processing + GCS FUSE write race. Set explicit `lockDuration: 120_000` AND run a lock-extender interval inside the crawl processor:
  ```ts
  const crawlOpts = { connection, concurrency: 1, limiter,
    prefix: opts.bullmqPrefix, lockDuration: 120_000,
    stalledInterval: 30_000, maxStalledCount: 2 };
  const crawl = new Worker(QUEUE_CRAWL, async (job) => {
    const EXTEND_MS = 120_000;
    const extender = setInterval(async () => {
      try { await job.extendLock(job.token!, EXTEND_MS); }
      catch (e) { logger.warn({ jobId: job.id, err: (e as Error).message }, "extendLock failed"); }
    }, EXTEND_MS - 10_000);
    try { /* ...download_files()... */ } finally { clearInterval(extender); }
  }, crawlOpts);
  ```
- **429 handling via `worker.rateLimit()`:** Native `fetch` inside the downloader cannot be intercepted, but if a 429 surfaces as a thrown error (or the downloader exits with a status code we can inspect post-hoc), wrap the call:
  ```ts
  try { await new WaybackMachineDownloader({...}).download_files(); }
  catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/429|rate.?limit/i.test(msg)) {
      await exact.rateLimit(60_000);
      throw Worker.RateLimitError();   // re-queue, does NOT consume an attempt
    }
    throw err;
  }
  ```
  Source: [BullMQ rate-limiting docs](https://docs.bullmq.io/guide/rate-limiting).
- **Observability — attach a structured QueueEvents logger:** add helper `attachQueueLogger(name, events, logger)` that emits one log line per `active|completed|failed|stalled` state transition with `{ queue, jobId, durationMs, event }`. Track `startTimes` in a `Map` keyed by `jobId`. Use the existing pino object-first convention `[worker:exact] message`.
- **Ref:** framework-docs-researcher (BullMQ 5.71), best-practices-researcher (BullMQ telemetry 2026), repo-research-researcher (pino conventions at `src/services/proxy.ts:29`).

### Step 7: Archive job client (producer + waiter)
- **Test:** `tests/clients/archive-job-client.test.ts` — `enqueueExactAndWait("https://example.com/", "20200101000000")` adds a job to `QUEUE_EXACT`, waits via `QueueEvents.waitUntilFinished`, resolves on success, throws on failure. SSRF: `enqueueExactAndWait("https://evil.com/", ...)` throws before enqueue. `enqueueDomainCrawl("example.com", "20200101000000")` adds to `QUEUE_CRAWL`, returns immediately (no await).
- **Implement:** `src/clients/archive-job-client.ts`. Replaces `src/clients/wayback.ts`.
- **Code:**
  ```ts
  import { Queue, QueueEvents } from "bullmq";
  import { QUEUE_EXACT, QUEUE_CRAWL, ExactUrlJob, DomainCrawlJob } from "../queue/jobs";

  const JOB_OPTS = { attempts: 5, backoff: { type: "exponential" as const, delay: 1000 },
                     removeOnComplete: 100, removeOnFail: 1000 };
  const WAIT_TIMEOUT_MS = 300_000;

  export class ArchiveJobClient {
    constructor(
      private readonly exactQueue: Queue<ExactUrlJob>,
      private readonly crawlQueue: Queue<DomainCrawlJob>,
      private readonly exactEvents: QueueEvents,
      private readonly logger: pino.Logger,
      private readonly domainCrawlEnabled: boolean,
    ) {}

    async enqueueExactAndWait(url: string, time: string): Promise<void> {
      const job = await this.exactQueue.add("exact", { url, time }, JOB_OPTS);
      await job.waitUntilFinished(this.exactEvents, WAIT_TIMEOUT_MS);
    }

    async enqueueDomainCrawl(host: string, time: string): Promise<void> {
      if (!this.domainCrawlEnabled) return;
      await this.crawlQueue.add("crawl", { host, time }, { ...JOB_OPTS, attempts: 3 });
    }
  }
  ```
- **Constraint:** Foreground caller in `ProxyService` MUST validate SSRF (Wayback host prefix) before calling `enqueueExactAndWait`. The job client itself does not — it's a transport, not a policy layer.
- **Validation:** `pnpm test -- tests/clients/archive-job-client.test.ts`.

### Research Enhancement

- **Deterministic `jobId` for in-flight dedup:** without `jobId`, two simultaneous foreground requests for the same `(url, time)` create two distinct jobs → duplicate work + GCS FUSE write race. `Queue.add(name, data, { jobId })` returns the **existing** job if the jobId already exists; the second caller's `job.waitUntilFinished(events, ttl)` subscribes to the same execution. Custom jobId **must not be purely numeric** (throws `"Custom Id cannot be integers"`). Source: [BullMQ Job IDs](https://docs.bullmq.io/guide/jobs/job-ids).
  ```ts
  import { createHash } from "node:crypto";
  const exactJobId = (url: string, time: string) =>
    "e-" + createHash("sha256").update(`${url}|${time}`).digest("hex").slice(0, 16);
  const crawlJobId = (host: string, time: string) =>
    "c-" + createHash("sha256").update(`${host}|${time}`).digest("hex").slice(0, 16);
  // ... add(name, data, { ...JOB_OPTS, jobId: exactJobId(url, time) })
  ```
- **Age-based completion retention (prevents `waitUntilFinished` hang race):** with `removeOnComplete: 100`, a successful job purged from the ring buffer before the second caller subscribes causes `waitUntilFinished` to hang until timeout. Use `removeOnComplete: { count: 100, age: 3600 }` so recent completions are kept for an hour regardless of count. Source: [BullMQ issue #85](https://github.com/taskforcesh/bullmq/issues/85).
- **`WAIT_TIMEOUT_MS` vs. retry/backoff arithmetic:** with `attempts: 5, delay: 1000`, between-attempt waits are `0+1+2+4+8 = 15s`; with each Wayback attempt up to ~60s, worst-case = `5*60 + 15 = 315s` — exceeding `WAIT_TIMEOUT_MS = 300_000`. **Two valid fixes** (pick one):
  - (Recommended) Reduce foreground attempts: `attempts: 3, delay: 2000` for exact → between-attempts `0+2+4 = 6s`, worst-case `3*60 + 6 = 186s`, set `WAIT_TIMEOUT_MS = 200_000`.
  - Keep `attempts: 5`, raise `WAIT_TIMEOUT_MS` to `325_000`.
- **Worker `'failed'` event for DLQ-style logging:** wire `exact.on("failed", (job, err) => logger.error({ jobId: job?.id, url: job?.data?.url, attemptsMade: job?.attemptsMade, err: err.message }, "[worker:exact] failed"))`. Belongs in Step 6 wiring; documented here because it's tied to JOB_OPTS semantics. `attemptsMade` is **not** on `QueueEvents` payloads — must use Worker event.
- **Ref:** framework-docs-researcher (BullMQ docs + community), best-practices-researcher (BullMQ retry timing arithmetic).

### Step 8: ProxyService rewrite
- **Test:** `tests/services/proxy.test.ts` — cache HIT: returns body with URL rewriting applied, no job enqueued. Cache MISS: enqueues exact-URL job, waits, re-reads cache, returns body. After successful HTML response: enqueues domain crawl. On job failure: throws with `{ status: 502 }`.
- **Implement:** `src/services/proxy.ts`. Drop `arcUrl`, drop `WaybackClient`. Pipeline: lookup → on miss enqueue+wait → lookup again → read file → if HTML/CSS apply `rewriteArchiveLinks`/`rewriteCssUrls`/`stripWaybackToolbar` (kept as defensive layer) → return. Fire `enqueueDomainCrawl` async (no await) for successful HTML hits with a fresh host.
- **Code:**
  ```ts
  async fetch(targetUrl: string, time: string): Promise<ProxyResult> {
    const u = new URL(targetUrl);
    let hit = await this.cache.lookup(targetUrl, time);
    let cacheStatus: "HIT" | "MISS" = "HIT";
    if (!hit) {
      this.logger.info({ targetUrl, time }, "[CACHE MISS] enqueueing exact-url job");
      await this.archiveJobClient.enqueueExactAndWait(targetUrl, time);
      hit = await this.cache.lookup(targetUrl, time);
      cacheStatus = "MISS";
      if (!hit) throw Object.assign(new Error("Job completed but cache empty"), { status: 502 });
    }
    const raw = await fs.readFile(hit.absPath);
    const isHtml = hit.contentType.startsWith("text/html");
    const isCss = hit.contentType.startsWith("text/css");
    let body: string | Buffer = raw;
    if (isHtml) {
      const html = stripWaybackToolbar(raw.toString("utf-8"), targetUrl);
      body = rewriteArchiveLinks(
        rewriteCssUrls(html, this.config.proxyBase, time),
        this.config.proxyBase);
      if (cacheStatus === "MISS") {
        void this.archiveJobClient.enqueueDomainCrawl(u.hostname, time)
          .catch((e) => this.logger.warn({ host: u.hostname, error: e?.message }, "crawl enqueue failed"));
      }
    } else if (isCss) {
      body = rewriteCssUrls(raw.toString("utf-8"), this.config.proxyBase, time);
    }
    return { contentType: hit.contentType, archiveUrl: targetUrl, originalUrl: targetUrl,
             archiveTime: time, body, cache: cacheStatus };
  }
  ```
- **Constraint:** Drop the prefetch-resources logic — the downloader fetches assets in the same crawl. The old `prefetchResourceUrls` / `collectWaybackResourceUrls` code is removed.
- **Constraint:** `stripWaybackToolbar` retained — package may not use `id_` modifier; defensive strip is cheap.
- **Validation:** `pnpm test -- tests/services/proxy.test.ts`.

### Research Enhancement

- **CDX preflight count check before enqueueDomainCrawl:** a user requesting `wikipedia.org` would trigger an unbounded crawl. Wayback IP-blocks after 60 req/min sustained. Add a CDX page-count check + per-host 24h budget before enqueue:
  ```ts
  // src/clients/archive-job-client.ts — inside enqueueDomainCrawl
  async function cdxPageCount(host: string, time: string): Promise<number> {
    const u = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(host + "/*")}`
      + `&from=${time}&to=${time}&output=json&showNumPages=true`;
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`CDX preflight ${r.status}`);
    return Number.parseInt((await r.text()).trim(), 10) || 0;
  }
  // Per-host budget — uses ioredis directly (passed in via constructor)
  async function budgetAvailable(redis: IORedis, host: string): Promise<boolean> {
    const res = await redis.set(`tm:crawl:budget:${host}`, "1", "EX", 86_400, "NX");
    return res === "OK";
  }
  // In enqueueDomainCrawl, before crawlQueue.add(...):
  const pages = await cdxPageCount(host, time);
  if (pages > config.crawlMaxCdxPages) { logger.warn({ host, pages }, "crawl skipped: too large"); return; }
  if (!await budgetAvailable(this.redis, host)) { return; } // already crawled today
  ```
  Adds two new config knobs: `CRAWL_MAX_CDX_PAGES` (default 50 ≈ 150k URLs) and uses the existing `redisUrl`. Source: [CDX server README](https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md), [Web Archive 2026 rate limits](https://archivarix.com/en/blog/webarchive-2026/).
- **`WHITELIST_HOSTS` enforcement on crawl:** the foreground URL is whitelist-checked at `time-machine.ts:172-176` and `:274-284`, but the inferred `u.hostname` for the fire-and-forget crawl is **not** re-checked. Add `if (!isHostWhitelisted(\`https://${u.hostname}\`, this.config.whitelistHosts)) return;` in `ProxyService.fetch` immediately before invoking `enqueueDomainCrawl`. Defense-in-depth mirrors the transport-layer pattern.
- **WS keepalive coexistence:** the WS message handler (`time-machine.ts:208-216`) fires `proxy.fetch` as fire-and-forget; the keepalive interval at `wsKeepaliveMs` runs independently. With `proxy.fetch` now blocking up to 200s, document that `WAIT_TIMEOUT_MS` MUST be `< wsKeepaliveMs * 2` to guarantee the client receives a ping before any timeout-induced terminate. Add an integration test that exercises WS + cold-cache + waitUntilFinished.
- **Cross-instance file visibility (GCS FUSE):** safe via `fs.access(path)` (direct stat), unsafe via `fs.readdir` (uses kernel list cache, TTL-bound). The current Step 4 code uses `fs.access` — keep it. No retry/sleep needed. Source: [GCS FUSE semantics.md](https://github.com/GoogleCloudPlatform/gcsfuse/blob/master/docs/semantics.md).
- **Ref:** best-practices-researcher (CDX preflight + budget), repo-research-researcher (whitelist + WS lifecycle).

### Step 9: Dependencies wiring
- **Test:** `tests/lib/dependencies.test.ts` — `new Dependencies(config).get()` exposes `redis`, `exactQueue`, `crawlQueue`, `exactEvents`, `workers`, `archiveJobClient`, `cache`, `proxy`. `dependencies.close()` calls `worker.close()` then `queue.close()` then `redis.quit()` in that order.
- **Implement:** `src/lib/dependencies.ts`. Add `close()` method called from `TimeMachineService.stop()`.
- **Code:**
  ```ts
  constructor(config: Config) {
    const logger = createLogger();
    const shutdown = new ShutdownController();
    const redis = createRedis(config.redisUrl);
    const exactQueue = new Queue(QUEUE_EXACT, { connection: redis, prefix: config.bullmqPrefix });
    const crawlQueue = new Queue(QUEUE_CRAWL, { connection: redis, prefix: config.bullmqPrefix });
    const exactEvents = new QueueEvents(QUEUE_EXACT, { connection: redis, prefix: config.bullmqPrefix });
    const cache = new CacheService(config);
    const workers = startArchiveWorkers({ connection: redis, cache, logger,
      workerConcurrency: config.workerConcurrency,
      workerRateLimitPerSec: config.workerRateLimitPerSec,
      downloaderThreadsCount: config.downloaderThreadsCount });
    const archiveJobClient = new ArchiveJobClient(exactQueue, crawlQueue, exactEvents, logger, config.domainCrawlEnabled);
    const proxy = new ProxyService(cache, archiveJobClient, logger, config);
    this.deps = { logger, shutdown, redis, exactQueue, crawlQueue, exactEvents, workers, cache, proxy, archiveJobClient, validator: { validateTargetUrl, isHostWhitelisted } };
  }
  async close(): Promise<void> {
    await Promise.all([this.deps.workers.exact.close(), this.deps.workers.crawl.close()]);
    await Promise.all([this.deps.exactQueue.close(), this.deps.crawlQueue.close(), this.deps.exactEvents.close()]);
    await this.deps.redis.quit();
  }
  ```
- **Constraint:** Close ordering matters — workers first (drain in-flight jobs), then queues + events, then Redis. Reverse order causes "Connection is closed" errors.
- **Validation:** `pnpm test -- tests/lib/dependencies.test.ts`.

### Research Enhancement

- **`dependencies.close()` wiring on SIGTERM:** currently `TimeMachineService.stop()` (verified `src/services/time-machine.ts:75-83`) only calls `shutdown.abort()` + closes HTTP/WS — it does **not** call `dependencies.close()`. Without this, the SIGTERM acceptance criterion cannot pass. Inject an `onStop` callback into `TimeMachineService` so `stop()` orchestrates the full sequence; keeps `src/index.ts` at its current three-line simplicity.
  ```ts
  // src/services/time-machine.ts — constructor adds onStop callback
  constructor(
    private readonly config: Config, /* ... */
    private readonly onStop?: () => Promise<void>,
  ) {}
  async stop(): Promise<void> {
    this.logger.info("TimeMachine shutting down...");
    this.shutdown.abort();
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => { this.wss.close(); this.server.close(() => resolve()); });
    await this.onStop?.();   // NEW — drains workers, queues, redis
  }
  // src/index.ts — wire it
  const service = new TimeMachineService(config, proxy, cache, validator, shutdown, logger,
    () => dependencies.close());
  ```
- **Worker `'failed'` event listener registration:** belongs in `startArchiveWorkers` so we don't lose pre-DI worker state. Emits `[worker:exact] failed` / `[worker:crawl] failed` log lines with `attemptsMade` (only available on Worker events, not QueueEvents).
- **Ref:** repo-research-researcher (verified current `stop()` flow + DI pattern).

### Step 10: Delete dead code
- **Implement:** Delete `src/clients/wayback.ts`, `src/lib/queue.ts`, `tests/clients/wayback.test.ts`, `tests/lib/queue.test.ts`. Drop unused exports from `src/lib/url-rewriter.ts`: `arcUrl`, `collectWaybackResourceUrls`, `rewriteImageUrlsFiltered`, `rewriteCssUrlsFiltered` (prefetch removed). Keep `rewriteArchiveLinks`, `rewriteCssUrls`, `stripWaybackToolbar`, `sanitizeTimeParam`, `unwrapNestedProxyUrl`.
- **Validation:** `pnpm typecheck && pnpm test && grep -rn "WaybackClient\|ArchiveRequestQueue\|arcUrl\b" src tests` returns zero hits.

### Step 11: Docs + deployment
- **Implement:**
  - `README.md` env table: remove `URL_PREFIX`, `ARCHIVE_RATE_PER_SEC`, `ARCHIVE_BURST`, `ARCHIVE_MAX_RETRIES`, `ARCHIVE_MAX_CONCURRENT`. Add `REDIS_URL`, `BULLMQ_PREFIX`, `DOMAIN_CRAWL_ENABLED`, `WORKER_CONCURRENCY`, `WORKER_RATE_LIMIT_PER_SEC`, `DOWNLOADER_THREADS_COUNT`.
  - `CHANGELOG.md`: note breaking cache invalidation (v1 entries dropped; new layout under `${cacheDir}/v2/`).
  - `cloudbuild.yaml`: add `--vpc-connector` arg and `--set-secrets=REDIS_PASSWORD=...` to the `gcloud run deploy` step. Document Memorystore + VPC Connector setup in `docs/deployment.md` (new).
  - `docker-compose.yml`: add Redis service for local dev.
- **Validation:** `grep -rn "URL_PREFIX\|ARCHIVE_RATE_PER_SEC" .` zero hits in non-archived files.

### Research Enhancement

- **Cloud Run flags for continuous workers:** the BullMQ worker runs in the same Cloud Run service as the HTTP handler. Cloud Run defaults throttle CPU when no request is active — workers would stall. Add to `gcloud run deploy`: `--min-instances=1 --no-cpu-throttling`. The 2026 flag is `--no-cpu-throttling` (not the older `--cpu-always-allocated`). Minimum memory: 512MiB. Cost: ~$10-15/mo for a 1vCPU/512MiB always-on instance. Source: [Cloud Run billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings), [Cloud Run always-on CPU blog](https://cloud.google.com/blog/topics/developers-practitioners/use-cloud-run-always-cpu-allocation-background-work).
- **VPC Connector for Memorystore:** add `--vpc-connector=<name> --vpc-egress=private-ranges-only` to the deploy step. Connector itself: separate `gcloud compute networks vpc-access connectors create` — out of scope for the code change but must be documented in `docs/deployment.md`.
- **pnpm tarball integrity is automatic in 10.26.0+:** the project already pins pnpm 10.26.0 via `.mise.toml`. `pnpm install --frozen-lockfile` verifies the sha512 integrity of HTTP-tarball installs against `pnpm-lock.yaml`. Add an acceptance criterion: `grep -A2 wayback-machine-downloader pnpm-lock.yaml | grep integrity` returns a non-empty match. Source: [pnpm PR #10287](https://github.com/pnpm/pnpm/pull/10287), [pnpm 10.26 release](https://pnpm.io/blog/releases/10.26).
- **Cache-clear API change (Step 4 follow-through):** the new tree layout supports `domain=*.example.com` natively (directory walk) but NOT `type=html|css|image` (no per-entry metadata). Either re-implement `type` filter via extension walk (`.html`, `.css`, image extensions) OR return `410 Gone` for `?type=...` with a CHANGELOG note. **Recommended:** keep `domain=` filter only; deprecate `type=` for v2.
- **Ref:** best-practices-researcher (Cloud Run 2026), repo-research-researcher (current cache-clear semantics).

### Step 12: Outbound HTTP proxy support (ProxyMesh / Squid)

- **Test:** `tests/lib/outbound-proxy.test.ts` — when `OUTBOUND_PROXY_URL` is set, `installOutboundProxy(config)` calls `undici.setGlobalDispatcher` exactly once with a `ProxyAgent` whose `uri` includes injected basic-auth credentials (URL-encoded). When unset, `setGlobalDispatcher` is NOT called. When `OUTBOUND_PROXY_USERNAME` is set without `OUTBOUND_PROXY_PASSWORD`, throw at startup with a clear message.
- **Implement:** `src/lib/outbound-proxy.ts`. Called from `src/index.ts` **before** `new Dependencies(config)` — must install the dispatcher before any `fetch()` (including BullMQ Lua-loader probes and the downloader's CDX queries). `undici` ships with Node 22 (no new dep needed; already a transitive of `bullmq`/`ioredis`). For ProxyMesh, the URL is `http://<endpoint>.proxymesh.com:31280` (e.g. `us-wa-load-balancer.proxymesh.com`). For IP-auth deployments (no creds), `OUTBOUND_PROXY_URL` alone is sufficient; for Basic-auth, both `USERNAME` and `PASSWORD` are required.
- **Code:**
  ```ts
  // src/lib/outbound-proxy.ts
  import { setGlobalDispatcher, ProxyAgent } from "undici";
  import type pino from "pino";
  import type { Config } from "../models/config";

  export function installOutboundProxy(
    cfg: Pick<Config, "outboundProxyUrl" | "outboundProxyUsername" | "outboundProxyPassword">,
    logger: pino.Logger,
  ): void {
    if (!cfg.outboundProxyUrl) return;
    const hasUser = !!cfg.outboundProxyUsername;
    const hasPass = !!cfg.outboundProxyPassword;
    if (hasUser !== hasPass) {
      throw new Error("OUTBOUND_PROXY_USERNAME and OUTBOUND_PROXY_PASSWORD must be set together");
    }
    const url = new URL(cfg.outboundProxyUrl);
    if (hasUser) {
      url.username = encodeURIComponent(cfg.outboundProxyUsername!);
      url.password = encodeURIComponent(cfg.outboundProxyPassword!);
    }
    setGlobalDispatcher(new ProxyAgent({ uri: url.toString() }));
    logger.info({
      host: url.host,
      auth: hasUser ? "basic" : "ip",
    }, "[outbound-proxy] installed");
  }
  ```
  Wire it in `src/index.ts` **before** `new Dependencies(config)`:
  ```ts
  import { installOutboundProxy } from "./lib/outbound-proxy";
  const config = loadConfig();
  ensureCacheDir(config.cacheDir);
  installOutboundProxy(config, createLogger()); // ← BEFORE Dependencies
  const dependencies = new Dependencies(config);
  ```
  Add to Step 3 `Config` interface:
  ```ts
  outboundProxyUrl: string;        // empty string = disabled
  outboundProxyUsername: string;   // empty = IP auth (whitelist)
  outboundProxyPassword: string;   // required if username set
  ```
  Add to Step 11 `README.md` env table:
  | `OUTBOUND_PROXY_URL` | `""` | HTTP/HTTPS proxy for outbound Wayback fetches (e.g. `http://us-wa-load-balancer.proxymesh.com:31280`). Empty = direct connection. |
  | `OUTBOUND_PROXY_USERNAME` | `""` | Basic-auth username for the proxy. Empty = IP whitelist authentication. |
  | `OUTBOUND_PROXY_PASSWORD` | `""` | Basic-auth password. Required when `OUTBOUND_PROXY_USERNAME` is set. |
- **Constraint:** `setGlobalDispatcher` is a process-wide mutation — call exactly once, at startup, before any other `fetch()`. Calling it multiple times is technically supported but masks misconfiguration bugs; the install function is idempotent (early-return if `outboundProxyUrl` empty) but should not be called twice.
- **Constraint:** ProxyMesh requires HTTP CONNECT tunneling for HTTPS targets (Wayback is HTTPS). `undici.ProxyAgent` handles CONNECT automatically — no extra configuration needed. Confirm in the test: a CONNECT request is issued for an `https://web.archive.org` target.
- **Constraint:** Credentials live in `.env.prod` and are injected via `--set-secrets=OUTBOUND_PROXY_PASSWORD=<secret>:latest` in `cloudbuild.yaml`. Never commit credentials to git.
- **Security:** `OUTBOUND_PROXY_URL` validation — must be `http://` or `https://`, parseable as URL; reject malformed at startup (fail-fast). Do not log the password (only `auth: "basic"|"ip"` indicator).
- **Validation:** `pnpm test -- tests/lib/outbound-proxy.test.ts && pnpm typecheck`. Manual verification: set `OUTBOUND_PROXY_URL` to a local Squid (`docker run -p 3128:3128 sameersbn/squid`), confirm Wayback fetches succeed through it (check Squid access.log).

### Research Enhancement

- **Why `undici.ProxyAgent` over `https-proxy-agent`:** Node 18+ `fetch` is undici-backed; setting the global dispatcher transparently routes both top-level fetches and the downloader's internal fetches. `https-proxy-agent` (Axios/request pattern) does not apply to native fetch. Source: [Node.js undici ProxyAgent docs](https://undici.nodejs.org/#/docs/api/ProxyAgent).
- **ProxyMesh endpoint discovery:** the ProxyMesh JS docs page does not list specific endpoint hostnames; the operator-facing dashboard at proxymesh.com lists endpoints (us-wa-load-balancer, world-load-balancer, etc.) on the configured plan. Default port `31280`. URL-embedded auth uses `http://user:pass@host:port`. Source: [ProxyMesh JS configuration docs](https://docs.proxymesh.com/article/41-javascript-proxy-configuration-examples).
- **Test strategy:** mock `undici.setGlobalDispatcher` via `jest.mock("undici", ...)`. Do **not** spin up a real proxy in unit tests — verify the dispatcher install is called with the right URL. Integration testing against a real proxy belongs in a manual checklist item.
- **Ref:** user-provided requirement; ProxyMesh JS docs; undici docs.

## Acceptance Criteria

- [ ] `pnpm test` green (all suites)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm check` (biome) clean
- [ ] Foreground request for an uncached URL returns the page within 60s (Wayback latency permitting)
- [ ] Foreground request for a cached URL returns within 100ms (file-read only)
- [ ] After a foreground HTML hit, the corresponding domain crawl job is enqueued exactly once (verify via BullMQ inspector or Redis `LLEN tm:archive:crawl:wait`)
- [ ] `WaybackClient`, `ArchiveRequestQueue`, `arcUrl` references are zero (grep)
- [ ] SSRF: `?url=https://evil.example.com/...` is rejected before enqueue (returns 400, no Redis writes)
- [ ] Path-traversal: `?url=https://example.com/../../etc/passwd&time=...` is rejected by `cache.lookup` (throws 400)
- [ ] Graceful shutdown: `kill -TERM <pid>` drains in-flight jobs, closes queues and Redis without "Connection is closed" warnings
- [ ] Concurrent identical requests share one job (deterministic `jobId` verified via Redis inspector)
- [ ] `pnpm install --frozen-lockfile` succeeds and `grep -A2 wayback-machine-downloader pnpm-lock.yaml | grep integrity` returns a sha512 line matching the research finding
- [ ] Outbound proxy: when `OUTBOUND_PROXY_URL` is set, `[outbound-proxy] installed` appears in startup logs and Wayback fetches route through the proxy (verify via Squid access.log in manual test)
- [ ] Outbound proxy: when only one of `OUTBOUND_PROXY_USERNAME` / `OUTBOUND_PROXY_PASSWORD` is set, startup fails fast with a clear error
- [ ] Worker prefix matches Queue prefix — jobs dequeue successfully (verified by smoke test)
- [ ] Cloud Run service has `--min-instances=1 --no-cpu-throttling` (verify via `gcloud run services describe`)

## Checklist (non-TDD cleanup)

- [ ] `package.json` engines/devDeps unchanged; new deps `bullmq`, `ioredis`, `wayback-machine-downloader` pinned to tarball URL or exact version
- [ ] `pnpm-lock.yaml` regenerated
- [ ] `.env.example` updated (or created) with new vars (including `OUTBOUND_PROXY_*`)
- [ ] `plans/multi-archive-memento-refactor.md` moved to `plans/archive/`
- [ ] No leaked Memorystore IPs, proxy credentials, or other secrets in committed files
- [ ] Worker `'failed'` event listener registered in `startArchiveWorkers` (logs `attemptsMade`)
- [ ] Structured `QueueEvents` logger (`attachQueueLogger`) attached for both queues

## Enrichment Summary

**Deepened:** 2026-05-20
**Gaps found:** 21 (via spec-flow-analyzer)
**New requirement added mid-deepen:** outbound HTTP proxy support (ProxyMesh / Squid) → Step 12
**Agents used:** spec-flow-analyzer, framework-docs-researcher, repo-research-researcher, best-practices-researcher
**Second opinion:** attempted but `second-opinion.js` exited non-zero — proceeded with agent findings only per spec
**Confidence:** synthesis not run (no contradictions between agents); 4 findings are critical bugs that would block startup or cause data races and were merged unanimously.

### Key Discoveries

- **Critical bug:** Worker constructors missing `prefix` → jobs would never dequeue under `tm:` prefix while Workers look at `bull:` default. (Step 6 enhancement.)
- **Critical bug:** `normalizeBaseUrlInput` returns `bareHost` not `host` — tarball source verification revealed the plan's type declaration AND the Worker code at two sites are wrong. (Step 1 + Step 6 enhancements.)
- **Critical timing bug:** `WAIT_TIMEOUT_MS=300_000` is shorter than worst-case `attempts:5` retry chain (~315s) — foreground caller times out while job still retrying. (Step 7 enhancement: reduce to `attempts:3` + `WAIT_TIMEOUT_MS=200_000`.)
- **Critical race:** Without deterministic `jobId`, two simultaneous identical requests duplicate work + collide on GCS FUSE writes. (Step 7 enhancement.)
- **`removeOnComplete: 100` hang race:** count-based purge can drop the job between two callers' `add()` and `waitUntilFinished()` — second caller hangs. Fix: `{ count: 100, age: 3600 }`. (Step 7 enhancement.)
- **wayback-machine-downloader characteristics confirmed via tarball inspection:** uses `id_` modifier, creates `directory` lazily, resolves silently on zero CDX results (worker MUST post-check or callers will get 502).
- **Cloud Run flag corrected:** `--no-cpu-throttling` (not the deprecated `--cpu-always-allocated`). Required for background workers to keep dequeuing during request lulls.
- **Wayback 2026 rate limits tightened:** 60 req/min. Worker `limiter: { max: 2, duration: 1000 }` exceeds this — recommended drop to `max: 1`.
- **CDX preflight + per-host budget required** before fire-and-forget crawl, otherwise `wikipedia.org`-class requests trigger unbounded crawls.
- **GCS FUSE close-to-open consistency** confirms no need for fsync/sleep-retry between worker write and reader access on the same instance.

### New Risks Identified

- **Risk: ESM resolver strictness on `wayback-machine-downloader/lib/utils.js`** (medium) — the path is on disk but not in package `exports`. Mitigation: pin to `0.5.0` and file an upstream PR.
- **Risk: `setGlobalDispatcher` is process-wide** (low) — also affects ioredis if it ever uses fetch (it does not), CDX preflight (intended), and any future HTTP client added to the codebase (intended). Document in `docs/deployment.md`.
- **Risk: Worker.RateLimitError() requires the downloader to surface 429 as a throwable error** (medium) — downloader silently swallows network errors per Gap 8 research. May need an upstream patch or a wrapping fetch instrumentation to surface 429s. Mitigation: rely on BullMQ's job-level `attempts` for transient failures + CDX preflight to avoid the hot path.
- **Risk: Cloud Run `--min-instances=1` costs ~$10-15/mo idle** (acknowledged in plan) — billable even when no requests. Acceptable for a small deployment; revisit if scale grows.
- **Risk: `cache.handleCacheClear` `type=` filter breaks for v2** (low) — return 410 Gone and document; clients that depended on it must migrate to `domain=` filter only.
