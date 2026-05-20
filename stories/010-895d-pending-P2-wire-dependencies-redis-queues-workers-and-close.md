---
id: "010-895d"
title: "Wire dependencies: Redis, queues, workers, and close()"
status: pending
priority: P2
type: feature
created: 2026-05-20T17:11:02.346Z
updated: 2026-05-20T17:11:02.346Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 9"
---

# Wire dependencies: Redis, queues, workers, and close()

## Problem Statement

src/lib/dependencies.ts must wire all new components and expose a close() method for graceful shutdown. TimeMachineService.stop() must call dependencies.close() via onStop callback.

## Acceptance Criteria

- [ ] src/lib/dependencies.ts wires redis, exactQueue, crawlQueue, exactEvents, workers, archiveJobClient, cache, proxy
- [ ] Queue and QueueEvents use prefix: config.bullmqPrefix
- [ ] close() shuts down: workers first, then queues+events, then redis.quit()
- [ ] TimeMachineService constructor accepts onStop?: () => Promise<void>
- [ ] stop() calls onStop?.() after closing HTTP/WS
- [ ] src/index.ts passes () => dependencies.close() as onStop
- [ ] tests/lib/dependencies.test.ts passes including close ordering

## Work Log

