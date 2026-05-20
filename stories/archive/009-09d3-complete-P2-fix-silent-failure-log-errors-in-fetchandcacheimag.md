---
id: 009-09d3
title: "Fix silent failure: log errors in fetchAndCacheImage and prefetchResources"
status: complete
priority: P2
created: "2026-05-20T01:52:56.147Z"
updated: "2026-05-20T02:18:12.499Z"
dependencies: []
---

# Fix silent failure: log errors in fetchAndCacheImage and prefetchResources

## Problem Statement

timemachine.ts:542 — fetchAndCacheImage has an empty catch that returns false with no logging. The comment in prefetchResources (line 561) claims errors are already logged inside fetchAndCacheImage — this is false. Every image prefetch failure is invisible in production. Also timemachine.ts:599 — handleCacheClear swallows the fs.readdir error without logging, making GCS FUSE mount failures undiagnosable.

## Acceptance Criteria

- [ ] fetchAndCacheImage catch block logs url, time, and error message at warn level
- [ ] prefetchResources catch callback logs unexpected rejections (not just swallows them)
- [ ] handleCacheClear readdir catch block logs cacheDir and error before returning 500
- [ ] Remove the misleading comment claiming errors are already logged

## Work Log

### 2026-05-20T02:18:12.349Z - Added console.warn to fetchAndCacheImage catch, prefetchResources catch; console.error to handleCacheClear readdir catch

