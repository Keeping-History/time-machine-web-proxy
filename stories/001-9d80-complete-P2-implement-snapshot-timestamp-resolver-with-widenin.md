---
id: 001-9d80
title: Implement snapshot timestamp resolver with widening CDX window search
status: complete
priority: P2
type: feature
created: "2026-05-21T22:26:59.128Z"
updated: "2026-05-21T22:32:31.012Z"
dependencies: []
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 1
started_at: "2026-05-21T22:27:54.238Z"
completed_at: "2026-05-21T22:32:31.011Z"
---

# Implement snapshot timestamp resolver with widening CDX window search

## Problem Statement

No pure pre-flight exists to find the closest Wayback snapshot at-or-before a requested timestamp. The worker needs this to pass a real from/to range to the downloader instead of a single exact second.

## Acceptance Criteria

- [x] resolveSnapshotTimestamp returns the latest snapshot ts <= requestedTime within the first window that has results
- [x] Widening kicks in when a narrower window returns empty — each window is tried in order
- [x] Multi-variant CDX queries are issued in parallel within each window
- [x] Returns null when all backward windows exhausted and allowLaterFallback is false
- [x] When allowLaterFallback is true and only later snapshots exist, returns the earliest ts > requestedTime
- [x] CDX non-OK HTTP status or malformed JSON treated as empty
- [x] npx jest tests/lib/snapshot-resolver.test.ts passes with all branches covered

## Files

- src/lib/snapshot-resolver.ts
- tests/lib/snapshot-resolver.test.ts

## QA

None — fully covered by 14 unit tests

## Work Log

### 2026-05-21T22:31:59.960Z - Implemented resolveSnapshotTimestamp with widening CDX windows, multi-variant Promise.all, on-or-before semantic via latest ts, optional forward fallback. 14 tests cover all branches incl. non-OK HTTP, malformed JSON, fetch rejection, clamping to MIN_TIMESTAMP, and from=null for unbounded window.

