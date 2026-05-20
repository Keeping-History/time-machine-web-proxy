---
id: "029-0626"
title: "Step 9: src/services/cache.ts — CacheService"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:31.982Z
updated: 2026-05-20T03:19:31.982Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 9"
---

# Step 9: src/services/cache.ts — CacheService

## Problem Statement

Extract CacheService class with filesystem cache read/write and cache-clear handler

## Acceptance Criteria

- [ ] Create src/services/cache.ts with CacheService class
- [ ] Constructor: Pick<Config, cacheDir|cacheEnabled>, pino.Logger
- [ ] Methods: get(url, time), put(url, time, entry), handleCacheClear(req, res)
- [ ] domainMatcher and matchesTypeFilter as private methods
- [ ] isCacheEntry guard from src/models/cache.ts used for deserialization validation
- [ ] Write tests/services/cache.test.ts: mock fs.promises, get returns null on ENOENT, put writes correct JSON, handleCacheClear filters by type and domain
- [ ] Tests green

## Work Log

