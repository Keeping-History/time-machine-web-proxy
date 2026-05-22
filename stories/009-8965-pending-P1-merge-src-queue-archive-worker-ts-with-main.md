---
id: "009-8965"
title: "Merge src/queue/archive-worker.ts with main"
status: pending
priority: P1
type: refactor
created: 2026-05-22T00:21:47.766Z
updated: 2026-05-22T00:21:47.766Z
dependencies: []
---

# Merge src/queue/archive-worker.ts with main

## Problem Statement

Architectural divergence — not a stale-vs-current merge. Main (280 lines, 3523a94/52505a9/d11e31c/58ad5d2/1de7165) inlines `findLatestSnapshotAtOrBefore`, CDX timeout 30s, and Wayback-snap (46b9395). Branch (236 lines) uses an injected `resolver` via the dependencies port (caa0535 'integrate snapshot resolver — fix from/to timestamp bug', c7b4dbc 'wire real resolveSnapshotTimestamp into worker'). The injected-resolver pattern is the hexagonal/modular direction; main carries production-tested fixes (Wayback snap, widened timeouts) that need to land somewhere.

## Acceptance Criteria

- [ ] Boss decides: keep DI/resolver architecture (branch) or inline (main)
- [ ] If DI wins: main's 30s CDX timeout, Wayback-snap behavior (46b9395), and 'Updates from PR' (d11e31c) explicitly ported into the resolver or worker as appropriate — none silently dropped
- [ ] If inline wins: branch's from/to timestamp bug fix (caa0535) preserved
- [ ] tests/queue/archive-worker.test.ts merge story completed and passing
- [ ] Worker can resolve and write a known archived URL end-to-end against a live Wayback request

## Files

- src/queue/archive-worker.ts

## Related

- src/services/cache.ts merge
- tests/queue/archive-worker.test.ts merge
- tests/lib/dependencies.test.ts merge

## Work Log

