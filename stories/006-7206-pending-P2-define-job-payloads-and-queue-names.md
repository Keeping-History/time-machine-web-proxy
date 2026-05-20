---
id: "006-7206"
title: "Define job payloads and queue names"
status: pending
priority: P2
type: feature
created: 2026-05-20T17:11:02.117Z
updated: 2026-05-20T17:11:02.117Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 5"
---

# Define job payloads and queue names

## Problem Statement

BullMQ job shapes need runtime validation to treat Redis as untrusted. Queue name constants must be shared between producer and consumer.

## Acceptance Criteria

- [ ] src/queue/jobs.ts exports QUEUE_EXACT, QUEUE_CRAWL, ExactUrlJob, DomainCrawlJob, assertExactUrlJob, assertDomainCrawlJob
- [ ] assertExactUrlJob validates url is http(s):// and time matches /^\d{14}$/
- [ ] assertDomainCrawlJob validates host non-empty and time format
- [ ] tests/queue/jobs.test.ts passes including invalid-input cases

## Work Log

