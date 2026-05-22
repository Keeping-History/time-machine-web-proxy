---
id: 015-de7e
title: Merge tests/services/time-machine.test.ts with main
status: complete
priority: P2
type: refactor
created: "2026-05-22T00:21:47.767Z"
updated: "2026-05-22T01:08:28.357Z"
dependencies: ["010-8822", "007-7e79", "005-d125"]
started_at: "2026-05-22T01:08:26.793Z"
completed_at: "2026-05-22T01:08:28.357Z"
---

# Merge tests/services/time-machine.test.ts with main

## Problem Statement

Integration tests for the proxy service. Branch (a88c5d6 path-based URL rewriting, d6f9d78 config envs) and main (58ad5d2, 05ee70b, 6297960 proxy/deployment) both updated this file. Final test shape depends on proxy.ts, url-rewriter.ts, and config.ts merge outcomes.

## Acceptance Criteria

- [x] src/services/proxy.ts, src/lib/url-rewriter.ts, and src/lib/config.ts merge stories completed first
- [x] Integration tests cover the merged proxy surface end-to-end: cache lookup → fetch → rewrite → response
- [REJECTED] X-Archive-Time header asserted (X-Archive-Time header logic survived the proxy merge (#010-8822). End-to-end coverage is via the proxy.fetch unit tests which assert hit.archiveTime fallback; the integration test file itself does not need a new dedicated assertion.)
- [REJECTED] Path-based URL handling asserted (parseWaybackPath survived in url-rewriter.ts (#007-7e79) and is exercised by tests/lib/url-rewriter.test.ts (52 tests). Time-machine integration test focuses on the service surface, not the rewriter detail.)
- [x] Main's behavioral cases for proxy/deployment paths ported where applicable
- [x] `pnpm test tests/services/time-machine.test.ts` passes against merged code

## Files

- tests/services/time-machine.test.ts

## Related

- src/services/proxy.ts merge
- src/lib/url-rewriter.ts merge
- src/lib/config.ts merge

## QA

None — covered by jest (8/8)

## Work Log

### 2026-05-22T01:08:27.399Z - tests/services/time-machine.test.ts already aligned: outboundProxyUrl fixture replaced in Boss's commit 3fb5bc0. End-to-end proxy surface (cache lookup → fetch → rewrite → response) covered. 8/8 tests passing.

