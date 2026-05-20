---
id: "004-6b0e"
title: "Add Redis/queue config knobs, remove old archive knobs"
status: pending
priority: P2
type: feature
created: 2026-05-20T17:11:01.997Z
updated: 2026-05-20T17:11:01.997Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 3"
---

# Add Redis/queue config knobs, remove old archive knobs

## Problem Statement

Config needs new fields for Redis, BullMQ, and worker tuning. Old fields (archiveRatePerSec, archiveBurst, archiveMaxConcurrent, archiveMaxRetries, archivePrefix) must be removed as BullMQ now owns rate/retry.

## Acceptance Criteria

- [ ] src/models/config.ts Config interface updated with redisUrl, bullmqPrefix, domainCrawlEnabled, workerConcurrency, workerRateLimitPerSec, downloaderThreadsCount, outboundProxyUrl, outboundProxyUsername, outboundProxyPassword
- [ ] Old archive knobs removed from Config
- [ ] Defaults: REDIS_URL=redis://localhost:6379, BULLMQ_PREFIX=tm, DOMAIN_CRAWL_ENABLED=true, WORKER_CONCURRENCY=2
- [ ] tests/lib/config.test.ts updated and passing
- [ ] pnpm typecheck passes

## Work Log

