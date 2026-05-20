---
id: "028-56b7"
title: "Step 8: src/clients/wayback.ts — WaybackClient"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:31.740Z
updated: 2026-05-20T03:19:31.740Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 8"
---

# Step 8: src/clients/wayback.ts — WaybackClient

## Problem Statement

Extract WaybackClient class with constructor injection of queue and shutdown controller

## Acceptance Criteria

- [ ] Create src/clients/wayback.ts with WaybackClient class
- [ ] Constructor injection: ArchiveRequestQueue, ShutdownController, pino.Logger, Pick<Config, archivePrefix|archiveMaxRetries>
- [ ] ARCHIVE_URL_PREFIX as private field derived from config.archivePrefix (security boundary)
- [ ] BACKOFF_STEPS_MS and BROWSER_HEADERS/BROWSER_UA as private constants
- [ ] Write tests/clients/wayback.test.ts: mock fetch, retry on retryable codes, rejection on non-retryable, SSRF guard (non-archive URL rejected), resource type headers
- [ ] Tests green

## Work Log

