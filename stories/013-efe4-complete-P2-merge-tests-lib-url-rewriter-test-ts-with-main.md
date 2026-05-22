---
id: 013-efe4
title: Merge tests/lib/url-rewriter.test.ts with main
status: complete
priority: P2
type: refactor
created: "2026-05-22T00:21:47.766Z"
updated: "2026-05-22T01:09:57.605Z"
dependencies: ["007-7e79"]
started_at: "2026-05-22T01:08:37.053Z"
completed_at: "2026-05-22T01:09:57.604Z"
---

# Merge tests/lib/url-rewriter.test.ts with main

## Problem Statement

Tests for the URL rewriter. Branch (a88c5d6) tests path-based rewriting against branch's API (parseWaybackPath/rewriteOneUrl). Main (35d5262) tests its own API (rewriteHtmlUrls/toProxyUrl). Whichever url-rewriter.ts implementation wins, the losing side's tests must be ported or rewritten.

## Acceptance Criteria

- [x] src/lib/url-rewriter.ts merge story completed first
- [x] Test file targets the chosen implementation's public API exclusively
- [x] Behavioral cases from BOTH sides (toolbar strip, srcset rewriting, CSS url(), path-based handling, sanitizeTimeParam, unwrapNestedProxyUrl) are covered — even if the API shape differs
- [x] `pnpm test tests/lib/url-rewriter.test.ts` passes against merged code

## Files

- tests/lib/url-rewriter.test.ts

## Related

- src/lib/url-rewriter.ts merge

## QA

None — covered by jest (76/76)

## Work Log

### 2026-05-22T01:09:56.605Z - Added 24 new tests for behaviors ported from main: broader non-proxyable schemes (11 cases), <base href> handling (strip + honor), <meta http-equiv=refresh>, extended URL-bearing attributes (cite/manifest/background/longdesc — 8 cases). 76/76 tests pass.

