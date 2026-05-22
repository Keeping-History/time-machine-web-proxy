---
id: 011-803e
title: Merge tests/lib/config.test.ts with main
status: pending
priority: P2
type: refactor
created: "2026-05-22T00:21:47.766Z"
updated: "2026-05-22T00:22:08.702Z"
dependencies: ["005-d125", "006-e759"]
---

# Merge tests/lib/config.test.ts with main

## Problem Statement

Tests for config — must match the merged src/lib/config.ts and src/models/config.ts. Branch added SNAPSHOT_WINDOW_DAYS/ALLOW_LATER_FALLBACK coverage (d6f9d78). Main has proxy/deployment-related test updates (58ad5d2, 05ee70b, 6297960).

## Acceptance Criteria

- [ ] config.ts and models/config.ts merges completed first
- [ ] Tests assert every env var that survives the config merge
- [ ] Tests removed for env vars dropped in the config merge — with explicit rationale captured in the story log
- [ ] `pnpm test tests/lib/config.test.ts` passes against merged code

## Files

- tests/lib/config.test.ts

## Related

- src/lib/config.ts merge
- src/models/config.ts merge

## Work Log

