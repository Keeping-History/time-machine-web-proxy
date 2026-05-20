---
id: "025-f5f3"
title: "Step 5: src/lib/queue.ts — ArchiveRequestQueue"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:10.328Z
updated: 2026-05-20T03:19:10.328Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 5"
---

# Step 5: src/lib/queue.ts — ArchiveRequestQueue

## Problem Statement

Extract ArchiveRequestQueue class from timemachine.ts

## Acceptance Criteria

- [ ] Create src/lib/queue.ts with ArchiveRequestQueue class
- [ ] Constructor: (maxConcurrent, ratePerSec, burst, maxQueueSize=200)
- [ ] Methods: enqueue, abort; getters: pending, running
- [ ] Write tests/lib/queue.test.ts: verify concurrency cap, rate limiting, abort() rejects pending
- [ ] Tests green

## Work Log

