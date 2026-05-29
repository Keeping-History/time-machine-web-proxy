---
id: 004-aa9c
title: "feat(config,cache): hint env vars and ?hints=1 + ?domain cross-walk in handleCacheClear"
status: blocked
priority: P3
type: feature
created: "2026-05-23T18:36:39.881Z"
updated: "2026-05-23T18:36:56.449Z"
dependencies: ["002-d955"]
plan: plans/persisted-embedded-ts-hints.md
plan_step: Step 3
---

# feat(config,cache): hint env vars and ?hints=1 + ?domain cross-walk in handleCacheClear

## Problem Statement

Step 3 of the persisted-embedded-ts-hints plan: add the five hint-related env vars (HINTS_ENABLED, HINT_TTL_DAYS, HINT_VERIFY_SAMPLE_RATE, HINT_LRU_MAX_ENTRIES, HINT_NEGATIVE_TTL_MS) and extend handleCacheClear to wipe hint sidecars. The cross-interaction matters: a ?domain=*.example.com clear today removes cached bytes but would leave orphan hints driving Tier 1 against now-empty cache. This story extends ?domain clears to also walk v2-hints/<host>.

## Acceptance Criteria

- [ ] HINT_TTL_DAYS env var: parses with default 180, range 1-3650, out-of-bounds rejected
- [ ] HINTS_ENABLED env var: parses bool with default true
- [ ] HINT_VERIFY_SAMPLE_RATE env var: parses float with default 0.01, range 0-1, out-of-bounds rejected
- [ ] HINT_LRU_MAX_ENTRIES env var: parses int with default 5000, range 100-100000
- [ ] HINT_NEGATIVE_TTL_MS env var: parses int with default 60000, range 0-3600000
- [ ] handleCacheClear ?hints=1 (no domain): fs.rm of <cacheDir>/v2-hints only; v2/ untouched
- [ ] handleCacheClear ?hints=1&domain=*.example.com: walks v2-hints/<host>/ removing matching host dirs only; v2/ untouched
- [ ] handleCacheClear ?domain=*.example.com (no ?hints flag): removes BOTH matching v2/<time>/<host> dirs AND matching v2-hints/<host> dirs
- [ ] handleCacheClear with no params: removes both v2/ and v2-hints/ roots (two fs.rm calls, both force: true)
- [ ] handleCacheClear response shape {deleted, total} counts hint dirs in the totals when ?hints=1 or full clear
- [ ] Pick<Config, ...> on CacheService.constructor widened to include hintTtlDays and hintsEnabled
- [ ] pnpm test config.test.ts && pnpm test cache.test.ts both green

## Work Log

### 2026-05-23T18:36:56.324Z - Blocked pending trigger condition AND completion of story 002-d955 (the config knobs gate behavior added in 002-d955).

