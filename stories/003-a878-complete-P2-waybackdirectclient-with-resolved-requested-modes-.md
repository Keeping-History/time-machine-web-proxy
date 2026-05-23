---
id: 003-a878
title: WaybackDirectClient with resolved + requested modes + token bucket
status: complete
priority: P2
type: feature
created: "2026-05-23T01:01:40.219Z"
updated: "2026-05-23T01:07:44.802Z"
dependencies: []
plan: plans/direct-fetch-fast-path.md
plan_step: Step 3
started_at: "2026-05-23T01:07:41.379Z"
completed_at: "2026-05-23T01:07:44.801Z"
---

# WaybackDirectClient with resolved + requested modes + token bucket

## Problem Statement

No direct-fetch client today; all MISSes go through CDX-based worker which 30s-times-out on akamai assets. Need a two-mode client (resolved-TS no-redirect, requested-TS with redirect-follow) plus token-bucket rate limiter to avoid triggering Wayback rate limits once we are fast.

## Acceptance Criteria

- [x] fetchAtResolvedTime(url, ts) returns ok / not_found / fallback per upstream status
- [x] fetchAtResolvedTime treats any 3xx as fallback
- [x] fetchAtRequestedTime(url, ts) follows redirect and parses resolvedTime from response.url via /\/web\/(\d{14})id_\//
- [x] Malformed timestamp returns { outcome: fallback, reason: 'bad-timestamp' }
- [x] Both methods respect DIRECT_FETCH_TIMEOUT_MS via AbortSignal.timeout
- [x] Token bucket: with rate=20/s burst=30, 100 concurrent calls issue at most 50 in the first second
- [x] Uses globalThis.fetch so jest can stub per-test
- [x] pnpm test wayback-direct-client.test.ts green

## Files

- src/clients/wayback-direct-client.ts
- tests/clients/wayback-direct-client.test.ts

## QA

None — covered by 20 unit tests; all green

## Work Log

### 2026-05-23T01:07:15.593Z - Completed: WaybackDirectClient with resolved/requested modes and token bucket

