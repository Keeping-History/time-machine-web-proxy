---
id: 011-348d
title: Fix double GCS FUSE read per cached resource on HTML cache hits
status: complete
priority: P2
created: "2026-05-20T01:53:10.036Z"
updated: "2026-05-20T02:21:34.183Z"
dependencies: []
---

# Fix double GCS FUSE read per cached resource on HTML cache hits

## Problem Statement

timemachine.ts:547 — On every HTML cache hit, getCachedResourceUrls reads each resource cache file to check which are present, then prefetchResources calls fetchAndCacheImage for each URL which calls cacheGet again as a guard. Every already-cached image gets two GCS FUSE reads — one in getCachedResourceUrls, one in fetchAndCacheImage:520.

## Acceptance Criteria

- [ ] Pass the already-computed cachedUrls set from getCachedResourceUrls into prefetchResources so it can skip cacheGet for URLs already known to be cached
- [ ] Or combine getCachedResourceUrls and prefetchResources into one pass that checks cache and kicks off fetches in a single iteration
- [ ] No change in correctness — images still warm up in the background

## Work Log

### 2026-05-20T02:21:34.025Z - prefetchResources now accepts skip set; cache hit path passes cachedUrls to skip redundant cacheGet calls

