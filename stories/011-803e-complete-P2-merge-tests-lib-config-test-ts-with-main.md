---
id: 011-803e
title: Merge tests/lib/config.test.ts with main
status: complete
priority: P2
type: refactor
created: "2026-05-22T00:21:47.766Z"
updated: "2026-05-22T01:08:23.585Z"
dependencies: ["005-d125", "006-e759"]
started_at: "2026-05-22T01:08:21.689Z"
completed_at: "2026-05-22T01:08:23.583Z"
---

# Merge tests/lib/config.test.ts with main

## Problem Statement

Tests for config — must match the merged src/lib/config.ts and src/models/config.ts. Branch added SNAPSHOT_WINDOW_DAYS/ALLOW_LATER_FALLBACK coverage (d6f9d78). Main has proxy/deployment-related test updates (58ad5d2, 05ee70b, 6297960).

## Acceptance Criteria

- [x] config.ts and models/config.ts merges completed first
- [x] Tests assert every env var that survives the config merge
- [x] Tests removed for env vars dropped in the config merge — with explicit rationale captured in the story log
- [x] `pnpm test tests/lib/config.test.ts` passes against merged code

## Files

- tests/lib/config.test.ts

## Related

- src/lib/config.ts merge
- src/models/config.ts merge

## QA

None — covered by jest (18/18)

## Work Log

### 2026-05-22T01:08:22.566Z - tests/lib/config.test.ts already aligned with merged config (Boss's parallel commit 3fb5bc0 handled outboundProxyUrl → outboundProxyUrls rename + added new env-var coverage). 18/18 tests passing.

