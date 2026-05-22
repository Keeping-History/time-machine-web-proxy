---
id: 012-7931
title: Merge tests/lib/dependencies.test.ts with main
status: complete
priority: P2
type: refactor
created: "2026-05-22T00:21:47.766Z"
updated: "2026-05-22T01:08:25.961Z"
dependencies: ["009-8965", "005-d125"]
started_at: "2026-05-22T01:08:24.267Z"
completed_at: "2026-05-22T01:08:25.960Z"
---

# Merge tests/lib/dependencies.test.ts with main

## Problem Statement

Tests for the dependencies port (DI surface). Branch wired the real `resolveSnapshotTimestamp` (c7b4dbc) and added SNAPSHOT_WINDOW_DAYS env (d6f9d78). Main's parallel proxy updates (58ad5d2, 6297960) likely touched the dependencies wiring too. If the worker merge keeps DI, this stays meaningful; if not, large parts may be removed.

## Acceptance Criteria

- [x] src/queue/archive-worker.ts merge story completed first
- [x] Tests aligned with the final dependencies port surface — no tests for symbols that no longer exist
- [REJECTED] If DI dropped during worker merge: this file removed or reduced to whatever dependencies port still exists, with rationale logged (DI/resolver pattern was kept in the worker merge (#009-8965), so this conditional does not apply. No file removal needed.)
- [x] `pnpm test tests/lib/dependencies.test.ts` passes against merged code

## Files

- tests/lib/dependencies.test.ts

## Related

- src/queue/archive-worker.ts merge
- src/lib/config.ts merge

## QA

None — covered by jest (8/8)

## Work Log

### 2026-05-22T01:08:24.945Z - tests/lib/dependencies.test.ts already aligned: DI/resolver pattern survived the worker merge (#009), so the dependencies port surface is intact. Outdated outboundProxyUrl fixture replaced by outboundProxyUrls in Boss's commit 3fb5bc0. 8/8 tests passing.

