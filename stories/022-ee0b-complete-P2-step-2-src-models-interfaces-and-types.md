---
id: 022-ee0b
title: "Step 2: src/models — interfaces and types"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:03.113Z"
updated: "2026-05-20T14:27:30.487Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 2
started_at: "2026-05-20T14:26:18.715Z"
completed_at: "2026-05-20T14:27:30.487Z"
---

# Step 2: src/models — interfaces and types

## Problem Statement

Extract all interfaces and types from timemachine.ts into src/models/ files

## Acceptance Criteria

- [x] Create src/models/cache.ts with CacheEntry interface and isCacheEntry type guard
- [x] Create src/models/config.ts with Config interface
- [x] Create src/models/proxy.ts with ProxyResult interface
- [x] Create src/models/queue.ts with ResourceType type and QueueEntry interface
- [x] Create src/models/websocket.ts with WsRequest and WsResponse interfaces
- [x] pnpm run typecheck passes

## QA

None

## Work Log

### 2026-05-20T14:27:29.381Z - Completed: 5 model files created. Fixed isCacheEntry to validate archiveTime. Added proxyBaseHostname to Config. Moved isWsRequest guard to websocket model.

