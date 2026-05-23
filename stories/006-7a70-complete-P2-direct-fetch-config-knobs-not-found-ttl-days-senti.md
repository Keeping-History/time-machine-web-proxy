---
id: 006-7a70
title: Direct-fetch config knobs + NOT_FOUND_TTL_DAYS sentinel expiry
status: complete
priority: P2
type: feature
created: "2026-05-23T01:01:40.423Z"
updated: "2026-05-23T01:19:23.361Z"
dependencies: ["001"]
plan: plans/direct-fetch-fast-path.md
plan_step: Step 6
started_at: "2026-05-23T01:19:19.846Z"
completed_at: "2026-05-23T01:19:23.359Z"
---

# Direct-fetch config knobs + NOT_FOUND_TTL_DAYS sentinel expiry

## Problem Statement

Need env-var kill switches and tuning knobs (rate, concurrency, prewarm caps). Separately: 404 sentinels currently stick forever, so Wayback backfills stay invisible. Add TTL invalidation in CacheService.lookup.

## Acceptance Criteria

- [x] DIRECT_FETCH_ENABLED parses bool (default true); when false, dependencies.ts substitutes a passthrough returning fallback for all fetches
- [x] DIRECT_FETCH_MAX_CONCURRENT (default 10, 1-50), DIRECT_FETCH_TIMEOUT_MS (default 15000, 1000-60000) parse with bounds
- [x] DIRECT_FETCH_RATE_PER_SEC (default 20, 1-100), DIRECT_FETCH_BURST (default 30, 1-200) parse with bounds
- [x] PREWARM_ENABLED (default true), PREWARM_MAX_ASSETS_PER_PAGE (default 100, 0-500) parse with bounds
- [x] NOT_FOUND_TTL_DAYS parses
- [x] Out-of-range values rejected with informative error in config.test.ts
- [x] CacheService.lookup deletes a sentinel whose mtime is older than TTL and returns null
- [x] Structured log lines emit [direct] resolved-fetch, [prewarm] discovered/queued, [direct] requested-fetch, [direct] rate-limited, [cache] sentinel-expired
- [x] pnpm test config.test.ts && pnpm test cache.test.ts green

## Files

- src/models/config.ts
- src/services/cache.ts
- src/lib/dependencies.ts
- tests/models/config.test.ts
- tests/services/cache.test.ts

## QA

None — covered by automated tests (415 tests pass across 18 suites in worktree)

## Work Log

### 2026-05-23T01:18:52.415Z - Completed: config zod schema + sentinel TTL expiry + dependencies stub

