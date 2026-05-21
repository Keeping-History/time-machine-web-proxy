---
id: 002-5dee
title: Add SNAPSHOT_WINDOW_DAYS and ALLOW_LATER_FALLBACK config knobs
status: complete
priority: P2
type: feature
created: "2026-05-21T22:26:59.190Z"
updated: "2026-05-21T22:35:01.731Z"
dependencies: []
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 2
started_at: "2026-05-21T22:32:56.895Z"
completed_at: "2026-05-21T22:35:01.730Z"
---

# Add SNAPSHOT_WINDOW_DAYS and ALLOW_LATER_FALLBACK config knobs

## Problem Statement

The resolver window list and the later-fallback flag need to be operator-configurable via environment variables. The Config model and loader have no fields for them yet.

## Acceptance Criteria

- [x] Config.snapshotWindowDays is number[]
- [x] Config.allowLaterFallback is boolean
- [x] Invalid entries in SNAPSHOT_WINDOW_DAYS (non-numeric, negative) throw at loadConfig()
- [x] npx jest tests/lib/config.test.ts passes

## Files

- src/models/config.ts
- src/lib/config.ts
- tests/lib/config.test.ts

## QA

None — covered by 7 new config tests

## Work Log

### 2026-05-21T22:35:00.862Z - Added Config.snapshotWindowDays (number[]) and Config.allowLaterFallback (boolean). Loader parses SNAPSHOT_WINDOW_DAYS as trimmed CSV with default 30,365,3650,0; throws on non-numeric/negative/empty entries. ALLOW_LATER_FALLBACK accepts case-insensitive 'true' only; anything else is false. Updated test fixtures in dependencies.test.ts and time-machine.test.ts to satisfy new required fields. 203/203 tests pass.

