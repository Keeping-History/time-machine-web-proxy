---
id: 024-5ec1
title: "Step 4: src/lib/shutdown.ts — ShutdownController"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:10.084Z"
updated: "2026-05-20T14:30:43.069Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 4
started_at: "2026-05-20T14:29:42.700Z"
completed_at: "2026-05-20T14:30:43.068Z"
---

# Step 4: src/lib/shutdown.ts — ShutdownController

## Problem Statement

Extract ShutdownController and abortableSleep from timemachine.ts

## Acceptance Criteria

- [x] Create src/lib/shutdown.ts with ShutdownController class wrapping AbortController
- [x] Export abortableSleep(ms, signal): Promise<void>
- [x] Write tests/lib/shutdown.test.ts: abortableSleep resolves after ms, rejects when aborted mid-sleep
- [x] Tests green, pnpm run typecheck passes

## QA

None

## Work Log

### 2026-05-20T14:30:42.272Z - Completed: ShutdownController + abortableSleep(ms, signal). 5 tests green.

