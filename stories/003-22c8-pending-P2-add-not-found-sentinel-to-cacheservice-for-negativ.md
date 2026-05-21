---
id: "003-22c8"
title: "Add not-found sentinel to CacheService for negative caching"
status: pending
priority: P2
type: feature
created: 2026-05-21T22:26:59.255Z
updated: 2026-05-21T22:26:59.255Z
dependencies: []
plan: "plans/snapshot-timestamp-resolver.md"
plan_step: "Step 3"
---

# Add not-found sentinel to CacheService for negative caching

## Problem Statement

When the resolver finds no snapshot exists for a (url, time) pair, the result needs to be cached on disk so repeat requests return 404 immediately without re-querying Wayback. CacheService has no sentinel mechanism.

## Acceptance Criteria

- [ ] writeNotFoundSentinel(time, url) creates a file at <cacheDir>/v2/<time>/<host>/.notfound/<sha256(url).slice(0,16)>
- [ ] lookup(url, time) throws {status: 404} when a sentinel file exists for that url+time
- [ ] lookup returns null (does not throw) when neither cache file nor sentinel exists — no behavior change for the happy path
- [ ] Sentinel path computation uses the same resolve()+startsWith traversal guard as the existing lookup
- [ ] npx jest tests/services/cache.test.ts passes

## Files

- src/services/cache.ts
- tests/services/cache.test.ts

## Work Log

