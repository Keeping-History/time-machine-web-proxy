---
id: 003-22c8
title: Add not-found sentinel to CacheService for negative caching
status: complete
priority: P2
type: feature
created: "2026-05-21T22:26:59.255Z"
updated: "2026-05-21T22:37:00.774Z"
dependencies: []
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 3
started_at: "2026-05-21T22:35:13.478Z"
completed_at: "2026-05-21T22:37:00.773Z"
---

# Add not-found sentinel to CacheService for negative caching

## Problem Statement

When the resolver finds no snapshot exists for a (url, time) pair, the result needs to be cached on disk so repeat requests return 404 immediately without re-querying Wayback. CacheService has no sentinel mechanism.

## Acceptance Criteria

- [x] writeNotFoundSentinel(time, url) creates a file at <cacheDir>/v2/<time>/<host>/.notfound/<sha256(url).slice(0,16)>
- [x] lookup(url, time) throws {status: 404} when a sentinel file exists for that url+time
- [x] lookup returns null (does not throw) when neither cache file nor sentinel exists — no behavior change for the happy path
- [x] Sentinel path computation uses the same resolve()+startsWith traversal guard as the existing lookup
- [x] npx jest tests/services/cache.test.ts passes

## Files

- src/services/cache.ts
- tests/services/cache.test.ts

## QA

None — covered by 6 new cache tests

## Work Log

### 2026-05-21T22:36:59.763Z - Added writeNotFoundSentinel(time, url) which creates <root>/.notfound/<sha256-prefix-16> via mkdir -p + writeFile. Extended lookup() to check sentinel after file miss and throw {status:404} when sentinel exists. Sentinel keyed by full URL (protocol+host+pathname+search) so different URLs at same host get different sentinels. Traversal guard preserved via resolve() + startsWith check. 6 new tests covering write path, miss → null, sentinel → 404, file wins over sentinel, query-string disambiguation.

