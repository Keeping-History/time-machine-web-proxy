---
id: "031-0630"
title: "Step 11: src/services/time-machine.ts — TimeMachineService"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:43.949Z
updated: 2026-05-20T03:19:43.949Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 11"
---

# Step 11: src/services/time-machine.ts — TimeMachineService

## Problem Statement

Extract TimeMachineService class with HTTP and WebSocket handlers

## Acceptance Criteria

- [ ] Create src/services/time-machine.ts with TimeMachineService class
- [ ] Constructor: Config, ProxyService, CacheService, url-validator module, ShutdownController, pino.Logger
- [ ] Methods: start(): void, stop(): Promise<void>
- [ ] Replace all remaining console.log/warn/error with logger calls at correct levels (info: startup+listen+ws-connect+ws-disconnect+one-per-request; debug: full lifecycle; warn/error: failures)
- [ ] HTTP handler emits one logger.info per request with method, path, status, durationMs
- [ ] pnpm run typecheck passes; manual smoke test: node dist/timemachine.js starts cleanly

## Work Log

