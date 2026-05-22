---
id: 010-8822
title: Merge src/services/proxy.ts with main
status: pending
priority: P1
type: refactor
created: "2026-05-22T00:21:47.766Z"
updated: "2026-05-22T00:22:08.948Z"
dependencies: ["007-7e79", "008-5f87", "009-8965"]
---

# Merge src/services/proxy.ts with main

## Problem Statement

Both sides touched proxy.ts in parallel. Branch: path-based URL rewriting (a88c5d6), BullMQ prefix fix (b73e1c8), X-Archive-Time header (ad996a6). Main: URL rewriter wiring (35d5262), 'Updates from PR' (d11e31c), 30s timeouts (1de7165), Wayback-snap (46b9395). Surface must match the url-rewriter, cache, and worker merge outcomes.

## Acceptance Criteria

- [ ] src/lib/url-rewriter.ts merge story completed first so the API surface is known
- [ ] Branch's BullMQ-prefix fix (b73e1c8 — per-host crawl budget keys outside BullMQ prefix) preserved unless explicitly dropped
- [ ] Branch's X-Archive-Time response header (ad996a6) preserved unless explicitly dropped
- [ ] Main's 30s timeout widening (1de7165) preserved
- [ ] Main's Wayback-snap exact-URL behavior (46b9395) preserved
- [ ] tests/services/time-machine.test.ts merge story completed and passing
- [ ] End-to-end smoke: GET an archived page through the merged proxy returns rewritten HTML + X-Archive-Time header

## Files

- src/services/proxy.ts

## Related

- src/lib/url-rewriter.ts merge
- src/services/cache.ts merge
- src/queue/archive-worker.ts merge
- tests/services/time-machine.test.ts merge

## Work Log

