---
id: 003-9868
title: "feat(proxy): wire hint read/write into ProxyService MISS path and prewarm"
status: blocked
priority: P3
type: feature
created: "2026-05-23T18:36:26.492Z"
updated: "2026-05-23T18:36:55.654Z"
dependencies: ["002-d955"]
plan: plans/persisted-embedded-ts-hints.md
plan_step: Step 2
---

# feat(proxy): wire hint read/write into ProxyService MISS path and prewarm

## Problem Statement

Step 1 added CacheService.readHint/writeHint. This story wires them into ProxyService so MISSes consult the hint to drive Tier 1 (fetchAtResolvedTime with the persisted embedded TS) before falling through to Tier 2, and prewarm short-circuits when an existing hint already matches. Adds the [prewarm] duplicate-skip info log that the un-defer trigger condition queries against.

## Acceptance Criteria

- [ ] MISS with hint present + Tier 1 ok: fetchAtResolvedTime called with hint.embeddedTs; fetchAtRequestedTime NOT called; observedAt refreshed on success
- [ ] MISS with hint present + Tier 1 not_found: hint deleted, fetchAtRequestedTime called (Tier 2)
- [ ] MISS with hint present + Tier 1 fallback (5xx): hint preserved (deleteHint NOT called), Tier 2 called
- [ ] MISS without hint: existing Tier 2 path (regression guard)
- [ ] Tier 2 ok with resolvedTime: writeHint(url, resolvedTime) called
- [ ] Tier 2 ok with resolvedTime undefined: writeHint NOT called (inside existing if guard at proxy.ts:75-77)
- [ ] Prewarm with matching hint: fetchAtResolvedTime NOT called; logger.info emitted with {event: prewarm_duplicate_skip, url, embeddedTs, hintAge}
- [ ] Prewarm with mismatching hint: fetchAtResolvedTime called; hint overwritten on success
- [ ] Stale sentinel (within notFoundTtlDays) beats stale hint: cache.lookup throws 404 BEFORE readHint is reached (assert readHint NOT called)
- [ ] HINTS_ENABLED=false: readHint and writeHint NEVER called even on MISS
- [ ] HINT_VERIFY_SAMPLE_RATE>0: when Math.random falls below sample rate, background fetchAtRequestedTime fires and logs [cache] hint-drift-detected warn on mismatch
- [ ] HINT_VERIFY_SAMPLE_RATE=0 (default in tests): no background drift check fires
- [ ] Insertion order in proxy.ts: writeFile -> writeResolvedTimeSidecar -> writeHint -> writeContentTypeSidecar -> re-lookup
- [ ] pnpm test proxy.test.ts && pnpm typecheck both green

## Work Log

### 2026-05-23T18:36:55.528Z - Blocked pending trigger condition AND completion of story 002-d955 (which adds the CacheService primitives this story consumes).

