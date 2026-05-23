---
id: 001-a735
title: Add CacheService.writeFile + shared computeAbsPath helper
status: complete
priority: P2
type: feature
created: "2026-05-23T01:01:40.085Z"
updated: "2026-05-23T01:06:52.053Z"
dependencies: []
plan: plans/direct-fetch-fast-path.md
plan_step: Step 1
started_at: "2026-05-23T01:06:42.717Z"
completed_at: "2026-05-23T01:06:52.052Z"
---

# Add CacheService.writeFile + shared computeAbsPath helper

## Problem Statement

ProxyService has no atomic way to write bytes into cache. Prewarm + direct-fetch paths need writeFile with shared traversal guard (computeAbsPath) so read-path and write-path can never diverge.

## Acceptance Criteria

- [x] computeAbsPath returns same path lookup probes for given
- [x] Path-traversal payloads in URL pathname (e.g. %2e%2e/etc/passwd) reject with HTTP 400
- [x] writeFile round-trips: subsequent lookup returns the bytes
- [x] Partial tmp file does not satisfy lookup
- [x] pnpm test cache.test.ts green

## Files

- src/services/cache.ts
- tests/services/cache.test.ts

## QA

All criteria verified by unit tests. 143/143 tests green. No regressions.

## Work Log

### 2026-05-23T01:06:21.132Z - Completed: added computeAbsPath + writeFile with traversal guard and atomic rename

