---
id: "008-b912"
title: "Implement archive job client (producer + waiter)"
status: pending
priority: P2
type: feature
created: 2026-05-20T17:11:02.234Z
updated: 2026-05-20T17:11:02.234Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 7"
---

# Implement archive job client (producer + waiter)

## Problem Statement

ProxyService needs a producer that enqueues exact-URL jobs and blocks on completion, plus a fire-and-forget domain crawl producer. Concurrent identical requests must share one job.

## Acceptance Criteria

- [ ] src/clients/archive-job-client.ts exports ArchiveJobClient
- [ ] enqueueExactAndWait uses deterministic jobId (e- prefix + sha256 hex) to dedup concurrent identical requests
- [ ] removeOnComplete: { count: 100, age: 3600 } prevents waitUntilFinished hang race
- [ ] WAIT_TIMEOUT_MS set to 200_000 with attempts: 3 for exact queue
- [ ] enqueueDomainCrawl returns immediately (fire-and-forget)
- [ ] SSRF guard: url must start with https://web.archive.org/ before enqueue
- [ ] tests/clients/archive-job-client.test.ts passes including SSRF rejection and fire-and-forget

## Work Log

