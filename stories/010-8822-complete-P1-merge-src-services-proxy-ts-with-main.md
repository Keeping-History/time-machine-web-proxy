---
id: 010-8822
title: Merge src/services/proxy.ts with main
status: complete
priority: P1
type: refactor
created: "2026-05-22T00:21:47.766Z"
updated: "2026-05-22T01:02:14.448Z"
dependencies: ["007-7e79", "008-5f87", "009-8965"]
started_at: "2026-05-22T01:00:41.049Z"
completed_at: "2026-05-22T01:02:14.447Z"
---

# Merge src/services/proxy.ts with main

## Problem Statement

Both sides touched proxy.ts in parallel. Branch: path-based URL rewriting (a88c5d6), BullMQ prefix fix (b73e1c8), X-Archive-Time header (ad996a6). Main: URL rewriter wiring (35d5262), 'Updates from PR' (d11e31c), 30s timeouts (1de7165), Wayback-snap (46b9395). Surface must match the url-rewriter, cache, and worker merge outcomes.

## Acceptance Criteria

- [x] src/lib/url-rewriter.ts merge story completed first so the API surface is known
- [x] Branch's BullMQ-prefix fix (b73e1c8 — per-host crawl budget keys outside BullMQ prefix) preserved unless explicitly dropped
- [x] Branch's X-Archive-Time response header (ad996a6) preserved unless explicitly dropped
- [x] Main's 30s timeout widening (1de7165) preserved
- [x] Main's Wayback-snap exact-URL behavior (46b9395) preserved
- [REJECTED] tests/services/time-machine.test.ts merge story completed and passing (Forward-reference to story 015. Test conformance verified when 015 executes.)
- [REJECTED] End-to-end smoke: GET an archived page through the merged proxy returns rewritten HTML + X-Archive-Time header ([MANUAL] End-to-end smoke fetch — covered by post-deploy verification.)

## Files

- src/services/proxy.ts

## Related

- src/lib/url-rewriter.ts merge
- src/services/cache.ts merge
- src/queue/archive-worker.ts merge
- tests/services/time-machine.test.ts merge

## QA

- [ ] [MANUAL] Smoke: GET an archived URL via the proxy; confirm X-Archive-Time header present when sidecar exists.

## Work Log

### 2026-05-22T01:02:13.357Z - Kept branch's path-based rewriteHtmlUrls/rewriteCssUrls (proxyBase removed from config Pick), bullmqPrefix-namespaced Redis budget key, and archiveTime fallback for X-Archive-Time header. Ported main's CDX_TIMEOUT_MS 10s→30s and dayWindow(time) for cdxPageCount.

