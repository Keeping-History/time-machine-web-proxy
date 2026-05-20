---
id: 030-aa4d
title: "Step 10: src/services/proxy.ts — ProxyService"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:43.706Z"
updated: "2026-05-20T15:02:50.837Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 10
started_at: "2026-05-20T15:01:26.471Z"
completed_at: "2026-05-20T15:02:50.836Z"
---

# Step 10: src/services/proxy.ts — ProxyService

## Problem Statement

Extract ProxyService class with cache-hit/miss path, image prefetch, and resource prefetch

## Acceptance Criteria

- [x] Create src/services/proxy.ts with ProxyService class
- [x] Constructor: CacheService, WaybackClient, pino.Logger, Pick<Config, proxyBase|archivePrefix>
- [x] Methods: fetch(targetUrl, time): ProxyResult, fetchAndCacheImage(url, time), prefetchResources(html, time, skip), prefetchResourceUrls(urls, time, skip), getCachedResourceUrls(html, time)
- [x] Keep both prefetchResources and prefetchResourceUrls — two entry points for distinct call sites
- [x] Write tests/services/proxy.test.ts: mock CacheService and WaybackClient, cache HIT path, cache MISS fetch+cache path for HTML/CSS/binary, fetchAndCacheImage caches correctly
- [x] Tests green

## QA

None

## Work Log

### 2026-05-20T15:02:50.629Z - Implemented ProxyService with fetch (HIT/MISS paths for HTML/CSS/binary), fetchAndCacheImage, prefetchResources/ResourceUrls, getCachedResourceUrls; 11 tests green

