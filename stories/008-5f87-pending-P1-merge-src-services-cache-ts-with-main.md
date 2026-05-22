---
id: "008-5f87"
title: "Merge src/services/cache.ts with main"
status: pending
priority: P1
type: refactor
created: 2026-05-22T00:21:47.765Z
updated: 2026-05-22T00:21:47.765Z
dependencies: []
---

# Merge src/services/cache.ts with main

## Problem Statement

Branch (201 lines) is an architectural superset: adds writeResolvedTimeSidecar, readResolvedTime, writeNotFoundSentinel (608d465, ad996a6, 4bf7142 www-strip). Main (161 lines) has 'Cache updates' (52505a9) and 'Cache bug fix' (46b3f5c) — the latter overlaps branch's www-strip fix. Risk: main's bug fix might be the same one, or different. Need careful read of 46b3f5c.

## Acceptance Criteria

- [ ] Read commit 46b3f5c (main 'Cache bug fix') and confirm whether it duplicates or differs from branch's 4bf7142 www-strip fix
- [ ] Read commit 52505a9 (main 'Cache updates') and decide which changes survive the merge
- [ ] Branch's negative-cache sentinel (writeNotFoundSentinel) preserved unless Boss explicitly drops it
- [ ] Branch's resolved-time sidecar (writeResolvedTimeSidecar/readResolvedTime) preserved unless Boss explicitly drops it
- [ ] Final cache.ts has a single canonical lookup() — no duplicated/parallel codepaths
- [ ] Type-check passes; downstream consumers in worker/proxy compile against the merged surface

## Files

- src/services/cache.ts

## Related

- src/queue/archive-worker.ts merge
- src/services/proxy.ts merge

## Work Log

