# Plan: Direct-Fetch Fast Path for Asset MISSes

**Created:** 2026-05-22 | **Status:** Draft | **Effort:** M | **Branch:** wip/modular-refactor-pnpm-turborepo

## Summary

Bypass the BullMQ worker and CDX resolver on cache MISS by streaming directly from `https://web.archive.org/web/<ts>id_/<url>` into the cache file. Worker path stays as fallback for non-200 responses and as the sole path for domain crawls. Expected impact: per-asset MISS drops from 17–35s to ~50–500ms; eliminates 500s caused by CDX rate-limiting on resolver retries.

## Architecture Context

- Request path: `TimeMachineService` → `ProxyService.fetch(url, time)` → `cache.lookup` → on MISS, `archiveJobClient.enqueueExactAndWait` (worker → wayback-machine-downloader subprocess → cache file → re-lookup).
- Bottleneck sits between `cache.lookup` MISS and re-lookup HIT: the worker serializes at `WORKER_RATE_LIMIT_PER_SEC=1` and the snapshot-resolver + downloader make 2 CDX round-trips per asset.
- Cache layout: `<cacheDir>/v2/<requested-time>/<host>/<pathname>` with `index.html` for dir-style paths. Negative-cache sentinel (`<root>/.notfound/<sha256-prefix>`) and `.resolved-time` sidecar are already implemented in `CacheService`.
- `installOutboundProxy` (`src/lib/outbound-proxy.ts`) installs a global undici dispatcher — every `fetch()` automatically egresses through configured proxies, so the new direct client inherits proxy rotation for free.
- Wayback's `id_` suffix returns raw asset bytes without toolbar/URL injection — exactly what the cache needs to store, since `ProxyService` does its own HTML/CSS rewriting after read.
- `ArchiveJobClient` already deterministically dedups concurrent foreground requests via `jobId = sha256(url|time)`. Direct fetcher needs equivalent in-memory dedup.

## Research Findings

- `src/services/proxy.ts:60-77` — current MISS dispatch; the insertion point.
- `src/services/cache.ts:11-17` — `CacheHit` shape; `contentType` is derived from file extension via `mime-types`, not from upstream headers. Direct fetcher does not need to persist a content-type sidecar.
- `src/services/cache.ts:104-122` — `writeNotFoundSentinel` and `writeResolvedTimeSidecar` already exist; reuse for negative cache + resolved-time bookkeeping.
- `src/services/cache.ts:46-50, 62-66` — path-traversal guard (`startsWith(root + sep)`); the new cache-write helper MUST mirror this exactly. Cleanest: add `CacheService.writePathFor(url, time)` that returns the validated abs path so callers can stream into it without duplicating the guard.
- `src/clients/archive-job-client.ts:15-19, 61-68` — port pattern (`ArchiveJobClientPort`) to mirror for the new direct client.
- Wayback `web/<ts>id_/<url>` redirects to `web/<resolved-ts>id_/<url>` (suffix preserved). `fetch()` with default `redirect: "follow"` is safe; parse `response.url` to extract the resolved timestamp.
- `WORKER_RATE_LIMIT_PER_SEC=1` is a global token bucket via BullMQ `limiter`; raising it without first eliminating the foreground dependency on the worker will not help cold-page latency, because 15 parallel MISSes still serialize at the rate cap.

## Security Considerations

- URL is already validated by `TimeMachineService.validateTargetUrl` before reaching `ProxyService.fetch` — direct fetcher inherits this.
- Constructed upstream URL: `` `https://web.archive.org/web/${time}id_/${targetUrl}` `` — `targetUrl` must be appended as a literal pathname segment (Wayback does not require encoding here; encoding the colon would break the protocol). Use a regex assertion on `time` (`^\d{14}$`) before constructing the URL to prevent path injection via timestamp.
- File write goes through `CacheService` helper that re-applies the existing path-traversal guard — no new attack surface.
- Negative-cache sentinel uses sha256-truncated key (`cache.ts:113-117`), not user-controlled — no traversal risk.

## Performance Considerations

- Hot path: every cache MISS for an asset on an archived page. Today ~15 MISSes per cold IBM page load → expected 50–500ms each via direct fetch vs 17–35s via worker.
- Concurrency cap: introduce a semaphore (default 10) to avoid stampeding Wayback's edge from a single page load. No per-second rate limit initially — Wayback's snapshot edge is CDN-cached and tolerates higher concurrency than the CDX endpoint.
- In-flight dedup: in-process `Map<string, Promise<DirectResult>>` keyed by `${url}|${time}`. Without it, an HTML page with 15 `<img>` tags pointing to the same sprite triggers 15 upstream fetches.
- Memory: dedup map entries delete on settle; semaphore is FIFO. No unbounded growth.

## Steps

### Step 1: `CacheService.writePathFor` + atomic-write helper

- **Test:** `tests/services/cache.test.ts` — given (url, time), returns the same abs path that `lookup` probes; rejects traversal payloads; round-trips a buffer via the returned path and the file is then findable via `lookup`.
- **Implement:** `src/services/cache.ts` — extract the abs-path computation from `lookup` into a private helper, expose `writePathFor(url, time): Promise<string>` that returns the validated path and ensures the parent dir exists. Add `writeFile(url, time, body: Buffer): Promise<void>` that uses an atomic tmp+rename.
- **Code:**
  ```ts
  // src/services/cache.ts
  async writePathFor(url: string, time: string): Promise<string> {
    const abs = this.computeAbsPath(url, time); // shared with lookup()
    await fs.mkdir(dirname(abs), { recursive: true });
    return abs;
  }

  async writeFile(url: string, time: string, body: Buffer): Promise<void> {
    const abs = await this.writePathFor(url, time);
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, abs);
  }
  ```
- **Constraint:** `computeAbsPath` MUST be the single source of truth — `lookup` calls it too, so a path-resolution divergence is impossible. The traversal guard (`startsWith(root + sep)`) lives in `computeAbsPath`.
- **Validation:** `pnpm test cache.test.ts`

### Step 2: `WaybackDirectClient` port + adapter

- **Test:** `tests/clients/wayback-direct-client.test.ts` — mock undici / `fetch`:
  - 200 with body → returns `{ outcome: "ok", resolvedTime, bytes }`; resolved-time parsed from final-redirect URL.
  - 404 → returns `{ outcome: "not_found" }`.
  - 5xx / network throw → returns `{ outcome: "fallback", reason }`.
  - Constructs `https://web.archive.org/web/<time>id_/<url>` literally; rejects malformed time.
- **Implement:** `src/clients/wayback-direct-client.ts` — port + concrete `WaybackDirectClient` using global `fetch` (inherits the installed undici proxy dispatcher).
- **Code:**
  ```ts
  // src/clients/wayback-direct-client.ts
  export type DirectResult =
    | { outcome: "ok"; resolvedTime: string | null; bytes: Buffer }
    | { outcome: "not_found" }
    | { outcome: "fallback"; reason: string };

  export interface WaybackDirectClientPort {
    fetch(targetUrl: string, time: string, signal?: AbortSignal): Promise<DirectResult>;
  }

  const TS_RE = /^\d{14}$/;
  const RESOLVED_TS_RE = /\/web\/(\d{14})id_\//;
  const DIRECT_TIMEOUT_MS = 15_000;

  export class WaybackDirectClient implements WaybackDirectClientPort {
    constructor(private readonly logger: pino.Logger) {}

    async fetch(targetUrl: string, time: string): Promise<DirectResult> {
      if (!TS_RE.test(time)) return { outcome: "fallback", reason: "bad-timestamp" };
      const upstream = `https://web.archive.org/web/${time}id_/${targetUrl}`;
      let res: Response;
      try {
        res = await globalThis.fetch(upstream, {
          signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
          redirect: "follow",
        });
      } catch (e) {
        return { outcome: "fallback", reason: describeFetchError(e) };
      }
      if (res.status === 404) return { outcome: "not_found" };
      if (!res.ok) return { outcome: "fallback", reason: `upstream ${res.status}` };
      const bytes = Buffer.from(await res.arrayBuffer());
      const m = RESOLVED_TS_RE.exec(res.url);
      return { outcome: "ok", resolvedTime: m ? m[1] : null, bytes };
    }
  }
  ```
- **Constraint:** Use `globalThis.fetch` (not a captured top-level `fetch`) so jest tests can mock per-test. The `installOutboundProxy` dispatcher is set process-wide and applies regardless.
- **Validation:** `pnpm test wayback-direct-client.test.ts`

### Step 3: `ProxyService.fetch` wires direct path before worker, with fallback

- **Test:** `tests/services/proxy.test.ts` — extend existing MISS tests:
  - Direct `ok` → cache populated, `enqueueExactAndWait` NOT called, `cacheStatus: "MISS_DIRECT"`.
  - Direct `not_found` → `writeNotFoundSentinel` invoked, throws 404, `enqueueExactAndWait` NOT called.
  - Direct `fallback` → `enqueueExactAndWait` called, existing worker flow proceeds.
  - HTML response still goes through `stripWaybackToolbar` + `rewriteHtmlUrls` (the `id_` variant returns raw HTML; rewriting is still required because internal links are absolute).
- **Implement:** `src/services/proxy.ts` — inject `WaybackDirectClientPort` via constructor; insert between `cache.lookup` MISS and `archiveJobClient.enqueueExactAndWait`. Wire in `src/lib/dependencies.ts`.
- **Code:**
  ```ts
  // src/services/proxy.ts (excerpt)
  if (!hit) {
    const direct = await this.directClient.fetch(targetUrl, time);
    if (direct.outcome === "ok") {
      await this.cache.writeFile(targetUrl, time, direct.bytes);
      if (direct.resolvedTime) {
        await this.cache.writeResolvedTimeSidecar(time, targetUrl, direct.resolvedTime);
      }
      hit = await this.cache.lookup(targetUrl, time);
      cacheStatus = "MISS_DIRECT";
    } else if (direct.outcome === "not_found") {
      await this.cache.writeNotFoundSentinel(time, targetUrl);
      throw statusError("Not in archive", 404);
    } else {
      this.logger.info({ targetUrl, time, reason: direct.reason }, "[direct] fallback to worker");
      // existing worker flow:
      if (onProgress) await this.archiveJobClient.enqueueExactAndWait(targetUrl, time, onProgress);
      else await this.archiveJobClient.enqueueExactAndWait(targetUrl, time);
      hit = await this.cache.lookup(targetUrl, time);
      cacheStatus = "MISS_WORKER";
    }
    if (!hit) throw statusError(`Cache empty after fetch for ${targetUrl} @ ${time}`, 502);
  }
  ```
- **Constraint:** `ProxyResult.cache` literal type widens from `"HIT" | "MISS"` to `"HIT" | "MISS_DIRECT" | "MISS_WORKER"`. Update `src/models/proxy.ts` and any consumer that switches on this value. The `X-Cache` response header in `time-machine.ts` should map both MISS variants to `MISS` for client-facing compatibility but log the variant.
- **Validation:** `pnpm test proxy.test.ts` and `pnpm typecheck`

### Step 4: In-flight dedup + concurrency semaphore

- **Test:** `tests/clients/wayback-direct-client.test.ts` — wrap client with a `DedupingDirectClient` decorator:
  - Two concurrent `fetch(url, time)` calls invoke the underlying client exactly once and both receive the same result.
  - Errors don't poison the dedup map: a failure clears the in-flight entry so the next call retries.
  - Concurrency cap: with cap=2 and 5 concurrent calls to distinct URLs, only 2 underlying calls are in flight at any moment.
- **Implement:** `src/clients/deduping-direct-client.ts` — decorator over `WaybackDirectClientPort`. Map + semaphore. Wired in `dependencies.ts` between `WaybackDirectClient` and `ProxyService`.
- **Code:**
  ```ts
  // src/clients/deduping-direct-client.ts
  export class DedupingDirectClient implements WaybackDirectClientPort {
    private readonly inflight = new Map<string, Promise<DirectResult>>();
    private readonly queue: (() => void)[] = [];
    private active = 0;

    constructor(
      private readonly inner: WaybackDirectClientPort,
      private readonly maxConcurrent: number,
    ) {}

    fetch(targetUrl: string, time: string): Promise<DirectResult> {
      const key = `${targetUrl}|${time}`;
      const existing = this.inflight.get(key);
      if (existing) return existing;
      const p = this.runGated(() => this.inner.fetch(targetUrl, time))
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
      return p;
    }

    private async runGated<T>(fn: () => Promise<T>): Promise<T> {
      if (this.active >= this.maxConcurrent) {
        await new Promise<void>((resolve) => this.queue.push(resolve));
      }
      this.active++;
      try { return await fn(); }
      finally {
        this.active--;
        const next = this.queue.shift();
        if (next) next();
      }
    }
  }
  ```
- **Constraint:** Dedup is in-process only. Two Node processes will still race — acceptable today (single-process deployment); revisit when scaling horizontally.
- **Validation:** `pnpm test deduping-direct-client.test.ts`

### Step 5: Configuration knobs + observability

- **Test:** `tests/models/config.test.ts` — new env vars parse with defaults; values outside bounds rejected.
- **Implement:** `src/models/config.ts` — add:
  - `DIRECT_FETCH_ENABLED` (bool, default `true`) — kill switch.
  - `DIRECT_FETCH_MAX_CONCURRENT` (int, default `10`, range 1–50).
  - `DIRECT_FETCH_TIMEOUT_MS` (int, default `15000`).
  Wire kill switch in `dependencies.ts`: when false, use a passthrough `WaybackDirectClientPort` that always returns `{ outcome: "fallback", reason: "disabled" }`.
- **Code:**
  ```ts
  // src/models/config.ts (excerpt)
  directFetchEnabled: parseBoolEnv("DIRECT_FETCH_ENABLED", true),
  directFetchMaxConcurrent: parseIntEnv("DIRECT_FETCH_MAX_CONCURRENT", 10, { min: 1, max: 50 }),
  directFetchTimeoutMs: parseIntEnv("DIRECT_FETCH_TIMEOUT_MS", 15_000, { min: 1_000, max: 60_000 }),
  ```
- **Validation:** `pnpm test config.test.ts`

## Acceptance Criteria

- [ ] Cold page load of `/web/20010913100012/http://www.ibm.com/` resolves all subresources in under 5s wall-clock (vs 35s+ today). **[MANUAL]** — measured via Chrome DevTools network panel.
- [ ] `docker logs` shows `MISS_DIRECT` for asset MISSes, `MISS_WORKER` only on direct fallback.
- [ ] 404 assets (e.g. `winning_return.gif`) return 404 with a sentinel written, and the second request for the same URL returns 404 in <50ms.
- [ ] Direct-fetch failure (simulate via outbound proxy block to `web.archive.org`) falls back to worker path and still serves.
- [ ] `pnpm test` and `pnpm typecheck` both green.
- [ ] No regression in domain-crawl behavior — that path does not touch the direct fetcher.

## Checklist (non-TDD cleanup)

- [ ] Update `README.md` with the new env vars.
- [ ] Lint clean (`pnpm lint`).
- [ ] Confirm `X-Cache` response header still emits `HIT`/`MISS` for backward compat; log internal variant separately.
- [ ] **After validation in staging:** raise `WORKER_RATE_LIMIT_PER_SEC` from 1 to 5 in `.env` and observe CDX 429 rate. If clean, raise further.
- [ ] Delete obsolete TODO/DEFERRED comments touched during the refactor.
