---
id: "022-ee0b"
title: "Step 2: src/models — interfaces and types"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:03.113Z
updated: 2026-05-20T03:19:03.113Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 2"
---

# Step 2: src/models — interfaces and types

## Problem Statement

Extract all interfaces and types from timemachine.ts into src/models/ files

## Acceptance Criteria

- [ ] Create src/models/cache.ts with CacheEntry interface and isCacheEntry type guard (fix: guard must validate archiveTime)
- [ ] Create src/models/config.ts with Config interface
- [ ] Create src/models/proxy.ts with ProxyResult interface
- [ ] Create src/models/queue.ts with ResourceType type and QueueEntry interface
- [ ] Create src/models/websocket.ts with WsRequest and WsResponse interfaces
- [ ] pnpm run typecheck passes

## Work Log

