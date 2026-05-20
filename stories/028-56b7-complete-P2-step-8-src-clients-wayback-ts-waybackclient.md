---
id: 028-56b7
title: "Step 8: src/clients/wayback.ts — WaybackClient"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:31.740Z"
updated: "2026-05-20T14:57:38.729Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 8
started_at: "2026-05-20T14:54:19.719Z"
completed_at: "2026-05-20T14:57:38.728Z"
---

# Step 8: src/clients/wayback.ts — WaybackClient

## Problem Statement

Extract WaybackClient class with constructor injection of queue and shutdown controller

## Acceptance Criteria

- [x] Create src/clients/wayback.ts with WaybackClient class
- [x] Constructor injection: ArchiveRequestQueue, ShutdownController, pino.Logger, Pick<Config, archivePrefix|archiveMaxRetries>
- [x] ARCHIVE_URL_PREFIX as private field derived from config.archivePrefix
- [x] BACKOFF_STEPS_MS and BROWSER_HEADERS/BROWSER_UA as private constants
- [x] Write tests/clients/wayback.test.ts: mock fetch, retry on retryable codes, rejection on non-retryable, SSRF guard (non-archive URL rejected), resource type headers
- [x] Tests green

## QA

None

## Work Log

### 2026-05-20T14:57:38.545Z - Implemented WaybackClient with constructor injection, SSRF guard, retry logic, resource type headers; mocked abortableSleep for deterministic tests; all 80 tests green

