---
id: 014-1bec
title: Merge tests/queue/archive-worker.test.ts with main
status: pending
priority: P2
type: refactor
created: "2026-05-22T00:21:47.767Z"
updated: "2026-05-22T00:22:09.548Z"
dependencies: ["009-8965"]
---

# Merge tests/queue/archive-worker.test.ts with main

## Problem Statement

Tests for the worker. Branch (ad996a6, caa0535) tests the DI/resolver pattern and snapshot-resolver integration. Main (3523a94 availability check, 52505a9 cache updates, 5774ace 'Additional tests', 46b9395 Wayback-snap) tests the inline implementation. Test shape depends on which architecture wins in the worker merge.

## Acceptance Criteria

- [ ] src/queue/archive-worker.ts merge story completed first
- [ ] Test file uses the chosen worker architecture's mocks/dependencies — not a mix
- [ ] Coverage retained for: availability check, Wayback-snap, snapshot resolver (whichever survives), rate-limit handling, crawl-lock extension
- [ ] Main's 'Additional tests' (5774ace) reviewed and ported where they cover behavior the branch didn't
- [ ] `pnpm test tests/queue/archive-worker.test.ts` passes against merged code

## Files

- tests/queue/archive-worker.test.ts

## Related

- src/queue/archive-worker.ts merge

## Work Log

