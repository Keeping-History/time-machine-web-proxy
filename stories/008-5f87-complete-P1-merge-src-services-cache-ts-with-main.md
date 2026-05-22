---
id: 008-5f87
title: Merge src/services/cache.ts with main
status: complete
priority: P1
type: refactor
created: "2026-05-22T00:21:47.765Z"
updated: "2026-05-22T00:42:12.871Z"
dependencies: []
started_at: "2026-05-22T00:37:41.047Z"
completed_at: "2026-05-22T00:42:12.870Z"
---

# Merge src/services/cache.ts with main

## Problem Statement

Branch (201 lines) is an architectural superset: adds writeResolvedTimeSidecar, readResolvedTime, writeNotFoundSentinel (608d465, ad996a6, 4bf7142 www-strip). Main (161 lines) has 'Cache updates' (52505a9) and 'Cache bug fix' (46b3f5c) — the latter overlaps branch's www-strip fix. Risk: main's bug fix might be the same one, or different. Need careful read of 46b3f5c.

## Acceptance Criteria

- [x] Read commit 46b3f5c (main 'Cache bug fix') and confirm whether it duplicates or differs from branch's 4bf7142 www-strip fix
- [x] Read commit 52505a9 (main 'Cache updates') and decide which changes survive the merge
- [x] Branch's negative-cache sentinel (writeNotFoundSentinel) preserved unless Boss explicitly drops it
- [x] Branch's resolved-time sidecar (writeResolvedTimeSidecar/readResolvedTime) preserved unless Boss explicitly drops it
- [x] Final cache.ts has a single canonical lookup() — no duplicated/parallel codepaths
- [x] Type-check passes; downstream consumers in worker/proxy compile against the merged surface

## Files

- src/services/cache.ts

## Related

- src/queue/archive-worker.ts merge
- src/services/proxy.ts merge

## QA

None — covered by tsc --noEmit on src/; behavior tested in tests/services/cache.test.ts (not in conflict scope)

## Work Log

### 2026-05-22T00:42:11.678Z - Merged cache.ts: kept main's www-preserving cache key policy (hostname verbatim; www.x and x stay separate to avoid poisoning); kept main's directory-index fallback (/mac → /mac/index.html); kept branch's archiveTime in CacheHit; kept branch's writeResolvedTimeSidecar/readResolvedTime sidecar; kept branch's writeNotFoundSentinel + sentinel check in lookup() (throws 404 on sentinel hit). Worker (#009) must keep main's hostname write path to stay consistent — captured as a CONSTRAINT for that story.

