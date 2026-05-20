---
id: "011-8969"
title: "Delete dead code: WaybackClient, queue, arcUrl"
status: pending
priority: P2
type: chore
created: 2026-05-20T17:11:02.403Z
updated: 2026-05-20T17:11:02.403Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 10"
---

# Delete dead code: WaybackClient, queue, arcUrl

## Problem Statement

Old src/clients/wayback.ts, src/lib/queue.ts, and related test files must be removed. Unused url-rewriter exports (arcUrl, collectWaybackResourceUrls, rewriteImageUrlsFiltered, rewriteCssUrlsFiltered) must be dropped.

## Acceptance Criteria

- [ ] src/clients/wayback.ts deleted
- [ ] src/lib/queue.ts deleted
- [ ] tests/clients/wayback.test.ts deleted
- [ ] tests/lib/queue.test.ts deleted
- [ ] arcUrl, collectWaybackResourceUrls, rewriteImageUrlsFiltered, rewriteCssUrlsFiltered removed from src/lib/url-rewriter.ts
- [ ] grep -rn "WaybackClient|ArchiveRequestQueue|arcUrl\b" src tests returns zero hits
- [ ] pnpm typecheck && pnpm test pass

## Work Log

