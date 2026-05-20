---
id: "024-5ec1"
title: "Step 4: src/lib/shutdown.ts — ShutdownController"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:10.084Z
updated: 2026-05-20T03:19:10.084Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 4"
---

# Step 4: src/lib/shutdown.ts — ShutdownController

## Problem Statement

Extract ShutdownController and abortableSleep from timemachine.ts

## Acceptance Criteria

- [ ] Create src/lib/shutdown.ts with ShutdownController class wrapping AbortController
- [ ] Export abortableSleep(ms, signal): Promise<void>
- [ ] Write tests/lib/shutdown.test.ts: abortableSleep resolves after ms, rejects when aborted mid-sleep
- [ ] Tests green, pnpm run typecheck passes

## Work Log

