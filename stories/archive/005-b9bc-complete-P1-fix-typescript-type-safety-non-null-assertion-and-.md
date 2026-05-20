---
id: 005-b9bc
title: "Fix TypeScript type safety: non-null assertion and unsafe as cast"
status: complete
priority: P1
created: "2026-05-20T01:52:05.610Z"
updated: "2026-05-20T02:03:28.994Z"
dependencies: []
---

# Fix TypeScript type safety: non-null assertion and unsafe as cast

## Problem Statement

Two direct TypeScript standard violations: (1) timemachine.ts:314 uses this.queue.shift()\! to suppress the null check instead of guarding explicitly. (2) timemachine.ts:1140 casts caught unknown error as { status?: number } without any runtime check in the WS error handler.

## Acceptance Criteria

- [ ] Replace queue.shift()\! with explicit guard: const entry = this.queue.shift(); if (\!entry) break;
- [ ] Replace (e as { status?: number }).status with a proper type guard function hasStatus(e)
- [ ] Type guard: e \!== null && typeof e === object && status in e && typeof e.status === number
- [ ] No functional behavior change

## Work Log

### 2026-05-20T02:03:28.842Z - Implemented directly: changes applied and typecheck passes

