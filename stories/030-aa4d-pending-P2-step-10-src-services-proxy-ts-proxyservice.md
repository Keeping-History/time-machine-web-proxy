---
id: "030-aa4d"
title: "Step 10: src/services/proxy.ts — ProxyService"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:43.706Z
updated: 2026-05-20T03:19:43.706Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 10"
---

# Step 10: src/services/proxy.ts — ProxyService

## Problem Statement

Extract ProxyService class with cache-hit/miss path, image prefetch, and resource prefetch

## Acceptance Criteria

- [ ] Create src/services/proxy.ts with ProxyService class
- [ ] Constructor: CacheService, WaybackClient, pino.Logger, Pick<Config, proxyBase|archivePrefix>
- [ ] Methods: fetch(targetUrl, time): ProxyResult, fetchAndCacheImage(url, time), prefetchResources(html, time, skip), prefetchResourceUrls(urls, time, skip), getCachedResourceUrls(html, time)
- [ ] Keep both prefetchResources and prefetchResourceUrls — two entry points for distinct call sites
- [ ] Write tests/services/proxy.test.ts: mock CacheService and WaybackClient, cache HIT path, cache MISS fetch+cache path for HTML/CSS/binary, fetchAndCacheImage caches correctly
- [ ] Tests green

## Work Log

