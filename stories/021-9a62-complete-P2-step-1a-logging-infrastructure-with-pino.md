---
id: 021-9a62
title: "Step 1a: Logging infrastructure with pino"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:18:53.747Z"
updated: "2026-05-20T14:26:06.645Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 1a (Research Enhancement)
started_at: "2026-05-20T14:24:44.311Z"
completed_at: "2026-05-20T14:26:06.644Z"
---

# Step 1a: Logging infrastructure with pino

## Problem Statement

Replace all console.log/warn/error calls with structured pino logging at appropriate levels; info for startup and per-connection, debug for full request lifecycle

## Acceptance Criteria

- [x] Add pino to dependencies
- [x] Create src/lib/logger.ts exporting a pino instance with level from LOG_LEVEL env var
- [x] info level: startup config, server listen, WS connect/disconnect, one request log per HTTP connection
- [x] debug level: archive URL resolution, cache HIT/MISS, retry timing, rewrite pass, response size, WS frame events
- [x] warn level: retryable errors, cache write failures, prefetch failures
- [x] error level: non-retryable fetch failures, unhandled exceptions, shutdown errors
- [x] cacheClearToken must never appear in any log output
- [x] Create tests/lib/logger.test.ts: verify LOG_LEVEL respected, debug suppressed at info level, token not logged
- [x] Logger injected into all service/client classes via constructor

## QA

None

## Work Log

### 2026-05-20T14:25:52.911Z - Completed: src/lib/logger.ts with createLogger factory + singleton. 5 tests green. tsconfig.jest.json gets esModuleInterop for pino CJS compat.

