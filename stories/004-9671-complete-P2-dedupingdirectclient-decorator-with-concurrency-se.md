---
id: 004-9671
title: DedupingDirectClient decorator with concurrency semaphore
status: complete
priority: P2
type: feature
created: "2026-05-23T01:01:40.289Z"
updated: "2026-05-23T01:22:48.922Z"
dependencies: ["003"]
plan: plans/direct-fetch-fast-path.md
plan_step: Step 4
started_at: "2026-05-23T01:22:45.541Z"
completed_at: "2026-05-23T01:22:48.921Z"
---

# DedupingDirectClient decorator with concurrency semaphore

## Problem Statement

Without dedup, 15 references to the same sprite in HTML trigger 15 upstream fetches. Without concurrency cap, prewarm stampedes Wayback edge. Wrap WaybackDirectClient with in-flight Map + semaphore.

## Acceptance Criteria

- [x] Two concurrent same-arg calls invoke inner client once; both promises resolve to the same result
- [x] Failure clears inflight entry so next call retries
- [x] Concurrency cap respected: with cap=2 and 5 concurrent distinct-URL calls, at most 2 in flight at any moment
- [x] fetchAtResolvedTime and fetchAtRequestedTime dedup independently
- [x] pnpm test deduping-direct-client.test.ts green

## Files

- src/clients/deduping-direct-client.ts
- tests/clients/deduping-direct-client.test.ts

## QA

Covered by 8 unit tests in tests/clients/deduping-direct-client.test.ts: dedup for fetchAtResolvedTime and fetchAtRequestedTime, failure handling (rejection clears map), concurrency cap (cap=2 with 5 URLs), and namespace isolation. All tests green.

## Work Log

### 2026-05-23T01:22:25.115Z - Completed: DedupingDirectClient with in-flight map and semaphore

