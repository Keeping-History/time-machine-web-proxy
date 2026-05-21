---
status: in_progress
approved_at: "2026-05-21T22:26:59.149Z"
updated: "2026-05-21T22:27:54.318Z"
started_at: "2026-05-21T22:27:54.318Z"
---
# Plan: Snapshot Timestamp Resolver

**Created:** 2026-05-21 | **Status:** Draft | **Effort:** M | **Branch:** wip/modular-refactor-pnpm-turborepo

## Summary

Fix the Wayback "found 0 snapshots" bug caused by passing the same 14-digit timestamp as both `from_timestamp` and `to_timestamp` to `WaybackMachineDownloader`. Pre-flight CDX with widening time windows, picking the latest snapshot ≤ requested time. Negative-cache 404s with on-disk sentinels.

## Architecture Context

- Request flow: `TimeMachineService.httpHandler` → `ProxyService.fetch(url, time)` → `cache.lookup` (miss) → `archiveJobClient.enqueueExactAndWait` → BullMQ → `archive-worker` exact processor → `WaybackMachineDownloader(...).download_files()` → writes files into `<cacheDir>/v2/<requestedTime>/<host>/<path>` → ProxyService re-`lookup`s, reads file, returns.
- The gap: worker at `src/queue/archive-worker.ts:73-74` and `:125-126` passes `from_timestamp: time, to_timestamp: time` — same exact second — so CDX returns `[]` for any timestamp not coincidentally crawled.
- Library behavior to lean on: `node_modules/wayback-machine-downloader/lib/snapshot-index.js:32` already keeps the **latest** timestamp per file path when fed a real range. Once the range is fixed, the rest of the downloader does the right thing.
- 404 propagation already works via `errorHasStatus` in `src/lib/errors.ts` + status-aware branches in `TimeMachineService.httpHandler` (`src/services/time-machine.ts:178-181`). New work: surface "no snapshot exists" through the cache layer, not via worker exceptions (BullMQ would retry).

## Research Findings

- Wayback CDX endpoint `https://web.archive.org/cdx/search/cdx` (and the upstream library's `/xd`) treat `from`/`to` as inclusive bounds; `from=to=YYYYMMDDhhmmss` filters to that exact second.
- Apple.com 2001-09-12 reproducer: empty result for exact second; closest existing snapshot is `20010917011416` (5 days later); plenty of snapshots earlier in 2001 (`20010106…`).
- Wayback Availability API (`https://archive.org/wayback/available?url=...&timestamp=...`) returns the closest snapshot, but lacks a "before only" constraint — would require post-filtering.
- Downloader queries 4 URL variants (https/http × bare/www) for `apple.com` — log's `....` matches one CDX call per variant.
- BullMQ retries failed jobs (`attempts: 3` in `archive-job-client.ts:33`). Throwing on "no snapshot" would cost ~3× preflight calls per 404. Use sentinel-file + successful return instead.
- Project tests mock `wayback-machine-downloader` and `normalize-base-url` shim via `jest.mock`; `tests/queue/archive-worker.test.ts:25-40` shows the convention.

## Security Considerations

- CDX URL constructed via `URLSearchParams` / `encodeURIComponent` — no injection surface.
- Sentinel file path derived from requested URL — must reuse existing path-traversal guard from `CacheService.lookup` (`src/services/cache.ts:40-42`) when writing.
- No new auth surface, no new ingress, no new outbound hosts (CDX already in use by the downloader).

## Performance Considerations

- Cache-miss path adds 1–4 CDX preflight HTTP calls per window (one per variant, parallel within window). Default 4-window cascade × 4 variants = 16 worst-case calls per unanswerable request, but cascades stop at the first non-empty window.
- Negative-cache sentinel persists across requests — repeated 404s short-circuit at `lookup`, no HTTP.
- CDX rate limits (~15 req/min anonymous) — the worker's `workerRateLimitPerSec: 1` only governs job pickup, not HTTP within a job. Acceptable for v1; revisit if 429s appear.
- No memory/storage growth beyond one zero-byte sentinel file per unique negative `(url, time)`.

## Open Questions

None. User confirmed: widening windows + configurable (default 404) for no-match.

## Steps

### Step 1: Snapshot resolver — pure pre-flight

- **Test:** `tests/lib/snapshot-resolver.test.ts` — asserts: first-window hit returns max ts; widening kicks in when narrower is empty; multi-variant returns max across variants; CDX malformed/non-OK → treated as empty; `null` when all windows exhausted; forward fallback returns earliest when flag on; flag-off short-circuits forward search.
- **Implement:** `src/lib/snapshot-resolver.ts` — pure function, no I/O beyond `fetch`. Variants from `NormalizedBaseUrl.variants`.
- **Code:**
```ts
export interface ResolveOpts {
  variants: string[];           // ["https://apple.com", "http://www.apple.com", ...]
  requestedTime: string;        // 14-digit
  windowsDays: number[];        // e.g. [30, 365, 3650, 0]; 0 = unbounded
  allowLaterFallback: boolean;
  fetchImpl?: typeof fetch;     // injectable for tests
  logger: pino.Logger;
}

export async function resolveSnapshotTimestamp(o: ResolveOpts): Promise<string | null> {
  const f = o.fetchImpl ?? fetch;
  for (const days of o.windowsDays) {
    const from = days === 0 ? "0" : shiftTimestamp(o.requestedTime, -days);
    const ts = await pickInWindow(o.variants, from, o.requestedTime, "latest", f);
    if (ts) return ts;
  }
  if (!o.allowLaterFallback) return null;
  for (const days of o.windowsDays) {
    const to = days === 0 ? "29991231235959" : shiftTimestamp(o.requestedTime, +days);
    const ts = await pickInWindow(o.variants, o.requestedTime, to, "earliest", f);
    if (ts) return ts;
  }
  return null;
}

// pickInWindow: parallel CDX per variant, parse [[ts, url], ...], return max|min ts
// shiftTimestamp: parses YYYYMMDDhhmmss → Date.UTC, ± days, reformats; clamps to "19960101000000"
```
- **Validation:** `npx jest tests/lib/snapshot-resolver.test.ts`

### Step 2: Config knobs

- **Test:** extend `tests/lib/config.test.ts` — verify `SNAPSHOT_WINDOW_DAYS="30,365,3650,0"` parses to `[30, 365, 3650, 0]`, default fills when unset, malformed entries throw at load, `ALLOW_LATER_FALLBACK="true"` → true (any other value → false).
- **Implement:** `src/models/config.ts` + `src/lib/config.ts` — add two fields, parse CSV → number[].
- **Code:**
```ts
// models/config.ts
snapshotWindowDays: number[];
allowLaterFallback: boolean;

// lib/config.ts
const parseWindows = (csv: string): number[] => {
  const out = csv.split(",").map((s) => Number.parseInt(s.trim(), 10));
  if (out.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error(`Invalid SNAPSHOT_WINDOW_DAYS: ${csv}`);
  return out;
};
// in loadConfig():
snapshotWindowDays: parseWindows(process.env.SNAPSHOT_WINDOW_DAYS ?? "30,365,3650,0"),
allowLaterFallback: process.env.ALLOW_LATER_FALLBACK?.toLowerCase() === "true",
```
- **Validation:** `npx jest tests/lib/config.test.ts`

### Step 3: Cache sentinel — write + lookup-aware

- **Test:** extend `tests/services/cache.test.ts` — `writeNotFoundSentinel(time, url)` creates a file at `<root>/<host>/.notfound/<sha256(url).slice(0,16)>`; `lookup(url, time)` for a URL with a sentinel throws `{status: 404}`; lookup with no sentinel and no file returns `null`; sentinel write respects the existing traversal guard.
- **Implement:** `src/services/cache.ts` — add `writeNotFoundSentinel`; extend `lookup` to check sentinel before returning null.
- **Code:**
```ts
import { createHash } from "node:crypto";

private sentinelPath(time: string, url: string): string {
  const u = new URL(url);
  const root = this.cacheDirForJob(time, u.hostname);
  const key = createHash("sha256").update(`${u.protocol}//${u.host}${u.pathname}${u.search}`)
    .digest("hex").slice(0, 16);
  const abs = resolve(root, ".notfound", key);
  if (!abs.startsWith(root + sep)) throw Object.assign(new Error("traversal"), { status: 400 });
  return abs;
}

async writeNotFoundSentinel(time: string, url: string): Promise<void> {
  const abs = this.sentinelPath(time, url);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, "");
}

// in lookup(), AFTER the abs miss:
try { await fs.access(this.sentinelPath(time, url)); }
catch { return null; }
throw Object.assign(new Error("Not in archive"), { status: 404 });
```
- **Constraint:** sentinel key is sha256 of full URL so two URLs sharing a path under same host don't collide.
- **Validation:** `npx jest tests/services/cache.test.ts`

### Step 4: Worker integration — resolver + sentinel + no-throw

- **Test:** extend `tests/queue/archive-worker.test.ts` — resolver mock returns `"20010917011416"` → downloader called with `from_timestamp: "20010917011416", to_timestamp: "20010917011416"`; resolver returns `null` → `writeNotFoundSentinel` called, downloader NOT called, processor resolves (no throw, no retry). Same dual cases for crawl processor.
- **Implement:** `src/queue/archive-worker.ts` — inject `resolveSnapshotTimestamp` + cache sentinel method via `StartArchiveWorkersOpts`; call before constructing downloader.
- **Code:**
```ts
// StartArchiveWorkersOpts add:
resolver: (variants: string[], requestedTime: string) => Promise<string | null>;
cache: Pick<CacheService, "cacheDirForJob" | "writeNotFoundSentinel">;

// in exact processor:
const base = normalizeBaseUrlInput(url);
const resolved = await opts.resolver(base.variants, time);
if (resolved === null) {
  logger.warn({ url, time }, "[worker:exact] no snapshot ≤ requested time");
  await cache.writeNotFoundSentinel(time, url);
  return; // success — sentinel is the result
}
logger.info({ url, time, resolved }, "[worker:exact] resolved snapshot");
// existing downloader call, but:
from_timestamp: resolved,
to_timestamp: resolved,
```
- **Constraint:** crawl processor uses `https://${host}/` as the resolver input URL (so sentinel keyed by host root), passes resolver result to downloader.
- **Validation:** `npx jest tests/queue/archive-worker.test.ts`

### Step 5: Wire resolver through Dependencies

- **Test:** extend `tests/lib/dependencies.test.ts` — `Dependencies` constructs a resolver bound to config windows + flag; `startArchiveWorkers` receives it; `cache.writeNotFoundSentinel` is exposed on the cache instance handed to the worker.
- **Implement:** `src/lib/dependencies.ts` — build a closure that calls `resolveSnapshotTimestamp` with config values + logger, pass into `startArchiveWorkers`.
- **Code:**
```ts
const resolver = (variants: string[], requestedTime: string) =>
  resolveSnapshotTimestamp({
    variants,
    requestedTime,
    windowsDays: config.snapshotWindowDays,
    allowLaterFallback: config.allowLaterFallback,
    logger,
  });

const workers = startArchiveWorkers({
  connection: redis,
  cache,
  resolver,                             // new
  logger,
  bullmqPrefix: config.bullmqPrefix,
  workerConcurrency: config.workerConcurrency,
  workerRateLimitPerSec: config.workerRateLimitPerSec,
  downloaderThreadsCount: config.downloaderThreadsCount,
});
```
- **Validation:** `npx jest tests/lib/dependencies.test.ts`

### Step 6: Proxy 404 path — surface sentinel-driven 404 cleanly

- **Test:** extend `tests/services/proxy.test.ts` — after `enqueueExactAndWait` resolves, `lookup` throws `{status: 404}` → `ProxyService.fetch` re-throws (does not convert to 502). Existing 502 path (cache empty AND no sentinel) still triggers when neither file nor sentinel exists.
- **Implement:** `src/services/proxy.ts` — the second `lookup` may now throw; let it propagate. The "Job completed but cache empty" 502 only fires if `lookup` returns `null` (no file, no sentinel).
- **Code:**
```ts
if (!hit) {
  this.logger.info({ targetUrl, time }, "[CACHE MISS] enqueueing exact-url job");
  await this.archiveJobClient.enqueueExactAndWait(targetUrl, time);
  hit = await this.cache.lookup(targetUrl, time); // may throw {status:404} via sentinel
  cacheStatus = "MISS";
  if (!hit) {
    throw statusError(`Job completed but cache empty for ${targetUrl} @ ${time}`, 502);
  }
}
```
- **Constraint:** no behavior change to `lookup` callers that expect `null`-on-miss — the throw is reserved for the explicit sentinel.
- **Validation:** `npx jest tests/services/proxy.test.ts`

### Step 7: Docs

- **Implement:** `.env.example` + `README.md` — document `SNAPSHOT_WINDOW_DAYS` (default `"30,365,3650,0"`), `ALLOW_LATER_FALLBACK` (default `"false"`), the "on or before requested time" semantic, and the negative-cache behavior + how to clear it (`DELETE /cache?domain=apple.com`).
- **Validation:** `grep -E 'SNAPSHOT_WINDOW_DAYS|ALLOW_LATER_FALLBACK' .env.example README.md` returns hits in both.

## Acceptance Criteria

- [x] `curl 'http://localhost:8765/?url=http://www.apple.com&time=20010912000000'` returns 200 with archived HTML, `X-Archive-Time` header reflecting the resolved snapshot (e.g. one of the early-2001 timestamps, since 2001-09-17 is *after* 2001-09-12 — with default `ALLOW_LATER_FALLBACK=false`, resolved should be ≤ requested).
- [x] `curl 'http://localhost:8765/?url=http://www.apple.com&time=19900101000000'` returns 404 "Not found in archive" (no Wayback snapshot exists that far back).
- [x] Second request to the same 404 URL+time returns 404 in <100ms (sentinel hit, no CDX call) — verifiable by absence of new `[worker:exact]` log lines.
- [x] Worker logs show `[worker:exact] resolved snapshot {resolved: "..."}` distinct from requested time on cache misses.
- [x] `DELETE /cache?domain=apple.com` clears both cached files and `.notfound` sentinels.
- [x] All existing tests still pass.
- [x] `npm run typecheck` clean.

## Checklist (non-TDD cleanup)

- [ ] Lint clean (`npx biome check src tests`)
- [ ] No new dependencies added (resolver uses built-in `fetch`)
- [ ] `.env.example` updated
- [ ] README documents the new env vars and 404 semantic
- [ ] Worker logs include resolved timestamp on every success
- [ ] No retries on "no snapshot found" — confirmed by checking job `attemptsMade` stays at 1 in the 404 case
