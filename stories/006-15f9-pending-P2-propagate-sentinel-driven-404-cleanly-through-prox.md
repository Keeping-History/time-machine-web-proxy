---
id: 006-15f9
title: Propagate sentinel-driven 404 cleanly through ProxyService
status: pending
priority: P2
type: fix
created: "2026-05-21T22:26:59.446Z"
updated: "2026-05-21T22:27:07.171Z"
dependencies: ["003-22c8"]
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 6
---

# Propagate sentinel-driven 404 cleanly through ProxyService

## Problem Statement

After enqueueExactAndWait, ProxyService.fetch re-calls cache.lookup which can now throw {status:404} if the worker wrote a sentinel. The proxy must let this propagate as-is instead of converting it to a 502.

## Acceptance Criteria

- [ ] When cache.lookup throws {status:404} after job completes, ProxyService.fetch rethrows — not converts to 502
- [ ] TimeMachineService still surfaces a 404 response to the client (existing errorHasStatus branch already handles this)
- [ ] The 502 path (lookup returns null, no sentinel, no file) still triggers when a job completes but neither file nor sentinel was written
- [ ] npx jest tests/services/proxy.test.ts passes

## Files

- src/services/proxy.ts
- tests/services/proxy.test.ts

## Work Log

