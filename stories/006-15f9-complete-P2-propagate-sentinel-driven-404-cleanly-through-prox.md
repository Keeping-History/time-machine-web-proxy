---
id: 006-15f9
title: Propagate sentinel-driven 404 cleanly through ProxyService
status: complete
priority: P2
type: fix
created: "2026-05-21T22:26:59.446Z"
updated: "2026-05-21T22:44:10.306Z"
dependencies: ["003-22c8"]
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 6
started_at: "2026-05-21T22:43:12.951Z"
completed_at: "2026-05-21T22:44:10.306Z"
---

# Propagate sentinel-driven 404 cleanly through ProxyService

## Problem Statement

After enqueueExactAndWait, ProxyService.fetch re-calls cache.lookup which can now throw {status:404} if the worker wrote a sentinel. The proxy must let this propagate as-is instead of converting it to a 502.

## Acceptance Criteria

- [x] When cache.lookup throws {status:404} after job completes, ProxyService.fetch rethrows — not converts to 502
- [x] TimeMachineService still surfaces a 404 response to the client
- [x] The 502 path (lookup returns null, no sentinel, no file) still triggers when a job completes but neither file nor sentinel was written
- [x] npx jest tests/services/proxy.test.ts passes

## Files

- src/services/proxy.ts
- tests/services/proxy.test.ts

## QA

None — covered by 3 new proxy tests

## Work Log

### 2026-05-21T22:44:09.234Z - Existing ProxyService.fetch already propagates exceptions from cache.lookup naturally — no try/catch wraps either lookup call, so {status:404} thrown by the sentinel-aware lookup (added in 003-22c8) flows through unchanged. 502 path still fires only when lookup returns null (no file, no sentinel). 3 new tests lock in the contract: (a) sentinel-driven 404 after job completes, (b) sentinel hit on FIRST lookup short-circuits before enqueue, (c) null-after-job still throws 502.

