---
id: 012-7931
title: Merge tests/lib/dependencies.test.ts with main
status: pending
priority: P2
type: refactor
created: "2026-05-22T00:21:47.766Z"
updated: "2026-05-22T00:22:09.318Z"
dependencies: ["009-8965", "005-d125"]
---

# Merge tests/lib/dependencies.test.ts with main

## Problem Statement

Tests for the dependencies port (DI surface). Branch wired the real `resolveSnapshotTimestamp` (c7b4dbc) and added SNAPSHOT_WINDOW_DAYS env (d6f9d78). Main's parallel proxy updates (58ad5d2, 6297960) likely touched the dependencies wiring too. If the worker merge keeps DI, this stays meaningful; if not, large parts may be removed.

## Acceptance Criteria

- [ ] src/queue/archive-worker.ts merge story completed first (dictates whether DI/resolver pattern survives)
- [ ] Tests aligned with the final dependencies port surface — no tests for symbols that no longer exist
- [ ] If DI dropped during worker merge: this file removed or reduced to whatever dependencies port still exists, with rationale logged
- [ ] `pnpm test tests/lib/dependencies.test.ts` passes against merged code

## Files

- tests/lib/dependencies.test.ts

## Related

- src/queue/archive-worker.ts merge
- src/lib/config.ts merge

## Work Log

