---
id: 006-e759
title: Merge src/models/config.ts with main
status: pending
priority: P1
type: refactor
created: "2026-05-22T00:21:47.765Z"
updated: "2026-05-22T00:22:08.581Z"
dependencies: ["005-d125"]
---

# Merge src/models/config.ts with main

## Problem Statement

Models file for the config layer — paired with src/lib/config.ts. Branch added types for SNAPSHOT_WINDOW_DAYS / ALLOW_LATER_FALLBACK (d6f9d78). Main has parallel proxy/deployment updates (58ad5d2, 6297960). Type shape must stay in sync with the merged config.ts.

## Acceptance Criteria

- [ ] Diff of branch:src/models/config.ts vs origin/main:src/models/config.ts reviewed with Boss
- [ ] Final config model matches the surviving env keys from the config.ts merge exactly
- [ ] No `any` types introduced; no unused exports left behind
- [ ] Type-check passes (`pnpm typecheck` or equivalent)

## Files

- src/models/config.ts

## Related

- src/lib/config.ts merge

## Work Log

