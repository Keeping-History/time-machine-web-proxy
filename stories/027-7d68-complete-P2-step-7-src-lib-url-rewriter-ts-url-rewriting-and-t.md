---
id: 027-7d68
title: "Step 7: src/lib/url-rewriter.ts — URL rewriting and transformation"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:21.316Z"
updated: "2026-05-20T14:50:39.304Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 7
started_at: "2026-05-20T14:49:22.622Z"
completed_at: "2026-05-20T14:50:39.304Z"
---

# Step 7: src/lib/url-rewriter.ts — URL rewriting and transformation

## Problem Statement

Extract all URL rewriting functions and regex constants from timemachine.ts into a stateless module

## Acceptance Criteria

- [x] Create src/lib/url-rewriter.ts with all 10 regex constants
- [x] Export: sanitizeTimeParam, arcUrl, rewriteArchiveLinks, rewriteCssUrls, rewriteImageUrlsFiltered, rewriteCssUrlsFiltered, collectWaybackResourceUrls, stripWaybackToolbar
- [x] Export unwrapNestedProxyUrl(url, proxyBaseHostname) — receives proxyBaseHostname as parameter not closure
- [x] All rewrite functions accept proxyBase and prefix as parameters
- [x] Write tests/lib/url-rewriter.test.ts: rewriteArchiveLinks (absolute+relative), rewriteCssUrls, stripWaybackToolbar, sanitizeTimeParam, collectWaybackResourceUrls, unwrapNestedProxyUrl
- [x] Tests green

## QA

None

## Work Log

### 2026-05-20T14:50:39.116Z - Extracted all 10 regex constants and 9 rewrite functions to src/lib/url-rewriter.ts; parameterized arcUrl, sanitizeTimeParam, unwrapNestedProxyUrl; 25 new tests all green

