---
id: 025-f5f3
title: "Step 5: src/lib/queue.ts — ArchiveRequestQueue"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:10.328Z"
updated: "2026-05-20T14:39:39.805Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 5
started_at: "2026-05-20T14:30:51.691Z"
completed_at: "2026-05-20T14:39:39.804Z"
---

# Step 5: src/lib/queue.ts — ArchiveRequestQueue

## Problem Statement

Extract ArchiveRequestQueue class from timemachine.ts

## Acceptance Criteria

- [x] Create src/lib/queue.ts with ArchiveRequestQueue class
- [x] Constructor:
- [x] Methods: enqueue, abort; getters: pending, running
- [x] Write tests/lib/queue.test.ts: verify concurrency cap, rate limiting, abort() rejects pending
- [x] Tests green

## QA

All criteria verified and checked off

## Work Log

### 2026-05-20T14:39:20.885Z - Extracted ArchiveRequestQueue to src/lib/queue.ts; fixed test to pre-register rejection handlers before abort(); fixed drain() to run synchronously in enqueue() so maxQueueSize accounting is correct; all 22 tests green

