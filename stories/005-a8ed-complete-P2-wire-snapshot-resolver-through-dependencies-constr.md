---
id: 005-a8ed
title: Wire snapshot resolver through Dependencies constructor
status: complete
priority: P2
type: feature
created: "2026-05-21T22:26:59.382Z"
updated: "2026-05-21T22:43:00.305Z"
dependencies: ["004-9783", "002-5dee"]
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 5
started_at: "2026-05-21T22:41:35.565Z"
completed_at: "2026-05-21T22:43:00.304Z"
---

# Wire snapshot resolver through Dependencies constructor

## Problem Statement

The resolver closure needs config values (snapshotWindowDays, allowLaterFallback) and a logger to be bound. Dependencies constructs startArchiveWorkers — it must build and pass the resolver closure.

## Acceptance Criteria

- [x] Dependencies builds a resolver closure that calls resolveSnapshotTimestamp with config.snapshotWindowDays and config.allowLaterFallback
- [x] The closure is passed to startArchiveWorkers as the resolver option
- [x] cache instance passed to startArchiveWorkers exposes writeNotFoundSentinel
- [x] npx jest tests/lib/dependencies.test.ts passes

## Files

- src/lib/dependencies.ts
- tests/lib/dependencies.test.ts

## QA

None — covered by 3 new dependencies tests

## Work Log

### 2026-05-21T22:42:59.190Z - Replaced DEFERRED identity-stub resolver in Dependencies with a closure that calls resolveSnapshotTimestamp using config.snapshotWindowDays + config.allowLaterFallback. CacheService instance handed to startArchiveWorkers already exposes writeNotFoundSentinel since the cache services type was widened in story 004. 3 new dependencies tests assert resolver presence, correct config wiring, and sentinel method exposure.

