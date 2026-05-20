---
id: "007-8036"
title: "Implement archive BullMQ worker"
status: pending
priority: P2
type: feature
created: 2026-05-20T17:11:02.177Z
updated: 2026-05-20T17:11:02.177Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 6"
---

# Implement archive BullMQ worker

## Problem Statement

Need a Worker process that consumes exact-url and domain-crawl jobs, calls wayback-machine-downloader, handles stall prevention for long crawls, and surfaces 429 as rate-limit errors.

## Acceptance Criteria

- [ ] src/queue/archive-worker.ts exports startArchiveWorkers returning { exact, crawl }
- [ ] Both workers use prefix from opts.bullmqPrefix
- [ ] Exact worker uses exact_url: true, crawl worker exact_url: false
- [ ] Crawl worker has lockDuration: 120_000 and lock-extender interval
- [ ] Workers use bareHost (not host) from normalizeBaseUrlInput
- [ ] Worker failed events emit structured logs with attemptsMade
- [ ] attachQueueLogger helper attached for both queues
- [ ] Worker rate limiter set to max: 1 per second (60 req/min safe ceiling)
- [ ] tests/queue/archive-worker.test.ts passes including retry and DomainCrawlJob cases

## Work Log

