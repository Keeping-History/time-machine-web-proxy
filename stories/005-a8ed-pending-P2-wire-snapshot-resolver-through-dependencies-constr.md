---
id: 005-a8ed
title: Wire snapshot resolver through Dependencies constructor
status: pending
priority: P2
type: feature
created: "2026-05-21T22:26:59.382Z"
updated: "2026-05-21T22:27:07.051Z"
dependencies: ["004-9783", "002-5dee"]
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 5
---

# Wire snapshot resolver through Dependencies constructor

## Problem Statement

The resolver closure needs config values (snapshotWindowDays, allowLaterFallback) and a logger to be bound. Dependencies constructs startArchiveWorkers — it must build and pass the resolver closure.

## Acceptance Criteria

- [ ] Dependencies builds a resolver closure that calls resolveSnapshotTimestamp with config.snapshotWindowDays and config.allowLaterFallback
- [ ] The closure is passed to startArchiveWorkers as the resolver option
- [ ] cache instance passed to startArchiveWorkers exposes writeNotFoundSentinel
- [ ] npx jest tests/lib/dependencies.test.ts passes

## Files

- src/lib/dependencies.ts
- tests/lib/dependencies.test.ts

## Work Log

