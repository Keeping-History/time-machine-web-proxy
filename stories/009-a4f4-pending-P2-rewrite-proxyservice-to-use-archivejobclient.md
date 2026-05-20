---
id: "009-a4f4"
title: "Rewrite ProxyService to use ArchiveJobClient"
status: pending
priority: P2
type: feature
created: 2026-05-20T17:11:02.290Z
updated: 2026-05-20T17:11:02.290Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 8"
---

# Rewrite ProxyService to use ArchiveJobClient

## Problem Statement

ProxyService currently calls WaybackClient directly. Must be replaced with cache lookup → on miss enqueue+wait → re-read cache → rewrite URLs pipeline. Domain crawl enqueue on HTML miss.

## Acceptance Criteria

- [ ] src/services/proxy.ts drops arcUrl and WaybackClient imports
- [ ] Cache HIT path: returns body with URL rewriting, no job enqueued
- [ ] Cache MISS path: enqueueExactAndWait, re-lookup, error 502 if still missing
- [ ] After HTML MISS: enqueueDomainCrawl (fire-and-forget) only if host passes WHITELIST_HOSTS check
- [ ] CDX preflight + per-host 24h budget checked before enqueueDomainCrawl
- [ ] stripWaybackToolbar retained as defensive layer
- [ ] prefetchResourceUrls and collectWaybackResourceUrls removed
- [ ] tests/services/proxy.test.ts passes all HIT/MISS/failure/domain-crawl scenarios

## Work Log

