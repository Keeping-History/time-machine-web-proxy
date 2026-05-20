---
id: "021-9a62"
title: "Step 1a: Logging infrastructure with pino"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:18:53.747Z
updated: 2026-05-20T03:18:53.747Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 1a (Research Enhancement)"
---

# Step 1a: Logging infrastructure with pino

## Problem Statement

Replace all console.log/warn/error calls with structured pino logging at appropriate levels; info for startup and per-connection, debug for full request lifecycle

## Acceptance Criteria

- [ ] Add pino to dependencies (pnpm add pino && pnpm add -D @types/pino)
- [ ] Create src/lib/logger.ts exporting a pino instance with level from LOG_LEVEL env var (default: info)
- [ ] info level: startup config, server listen, WS connect/disconnect, one request log per HTTP connection
- [ ] debug level: archive URL resolution, cache HIT/MISS, retry timing, rewrite pass, response size, WS frame events
- [ ] warn level: retryable errors, cache write failures, prefetch failures
- [ ] error level: non-retryable fetch failures, unhandled exceptions, shutdown errors
- [ ] cacheClearToken must never appear in any log output
- [ ] Create tests/lib/logger.test.ts: verify LOG_LEVEL respected, debug suppressed at info level, token not logged
- [ ] Logger injected into all service/client classes via constructor

## Work Log

