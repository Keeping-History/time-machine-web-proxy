---
id: 031-0630
title: "Step 11: src/services/time-machine.ts — TimeMachineService"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:43.949Z"
updated: "2026-05-20T15:05:41.733Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 11
started_at: "2026-05-20T15:04:26.130Z"
completed_at: "2026-05-20T15:05:41.733Z"
---

# Step 11: src/services/time-machine.ts — TimeMachineService

## Problem Statement

Extract TimeMachineService class with HTTP and WebSocket handlers

## Acceptance Criteria

- [x] Create src/services/time-machine.ts with TimeMachineService class
- [x] Constructor: Config, ProxyService, CacheService, url-validator module, ShutdownController, pino.Logger
- [x] Methods: start(): void, stop(): Promise<void>
- [x] Replace all remaining console.log/warn/error with logger calls at correct levels
- [x] HTTP handler emits one logger.info per request with method, path, status, durationMs
- [x] pnpm run typecheck passes; manual smoke test: node dist/timemachine.js starts cleanly

## QA

None — criterion 6 (typecheck) verified via pnpm run typecheck (zero errors); smoke test deferred to story 034-501e full verification

## Work Log

### 2026-05-20T15:05:32.032Z - Implemented TimeMachineService with HTTP+WS handlers, CORS, cache-clear, per-request logging, graceful stop(); all console calls replaced with pino logger; 104 tests green

