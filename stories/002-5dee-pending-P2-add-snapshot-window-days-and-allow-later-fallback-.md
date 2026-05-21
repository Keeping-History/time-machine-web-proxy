---
id: "002-5dee"
title: "Add SNAPSHOT_WINDOW_DAYS and ALLOW_LATER_FALLBACK config knobs"
status: pending
priority: P2
type: feature
created: 2026-05-21T22:26:59.190Z
updated: 2026-05-21T22:26:59.190Z
dependencies: []
plan: "plans/snapshot-timestamp-resolver.md"
plan_step: "Step 2"
---

# Add SNAPSHOT_WINDOW_DAYS and ALLOW_LATER_FALLBACK config knobs

## Problem Statement

The resolver window list and the later-fallback flag need to be operator-configurable via environment variables. The Config model and loader have no fields for them yet.

## Acceptance Criteria

- [ ] Config.snapshotWindowDays is number[] (parsed from SNAPSHOT_WINDOW_DAYS CSV, default [30,365,3650,0])
- [ ] Config.allowLaterFallback is boolean (ALLOW_LATER_FALLBACK=true sets to true, any other value is false)
- [ ] Invalid entries in SNAPSHOT_WINDOW_DAYS (non-numeric, negative) throw at loadConfig()
- [ ] npx jest tests/lib/config.test.ts passes

## Files

- src/models/config.ts
- src/lib/config.ts
- tests/lib/config.test.ts

## Work Log

