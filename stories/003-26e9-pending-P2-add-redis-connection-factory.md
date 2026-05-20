---
id: "003-26e9"
title: "Add Redis connection factory"
status: pending
priority: P2
type: feature
created: 2026-05-20T17:11:01.931Z
updated: 2026-05-20T17:11:01.931Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 2"
---

# Add Redis connection factory

## Problem Statement

BullMQ requires a specific ioredis connection config (maxRetriesPerRequest: null, enableReadyCheck: false). A shared factory ensures correct options across all consumers.

## Acceptance Criteria

- [ ] src/lib/redis.ts exports createRedis(url: string): IORedis
- [ ] createRedis sets maxRetriesPerRequest: null and enableReadyCheck: false
- [ ] tests/lib/redis.test.ts passes

## Work Log

