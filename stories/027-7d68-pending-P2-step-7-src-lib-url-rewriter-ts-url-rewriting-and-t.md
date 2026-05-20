---
id: "027-7d68"
title: "Step 7: src/lib/url-rewriter.ts — URL rewriting and transformation"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:21.316Z
updated: 2026-05-20T03:19:21.316Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 7"
---

# Step 7: src/lib/url-rewriter.ts — URL rewriting and transformation

## Problem Statement

Extract all URL rewriting functions and regex constants from timemachine.ts into a stateless module

## Acceptance Criteria

- [ ] Create src/lib/url-rewriter.ts with all 10 regex constants
- [ ] Export: sanitizeTimeParam, arcUrl, rewriteArchiveLinks, rewriteCssUrls, rewriteImageUrlsFiltered, rewriteCssUrlsFiltered, collectWaybackResourceUrls, stripWaybackToolbar
- [ ] Export unwrapNestedProxyUrl(url, proxyBaseHostname) — receives proxyBaseHostname as parameter not closure
- [ ] All rewrite functions accept proxyBase and prefix as parameters (not closed over)
- [ ] Write tests/lib/url-rewriter.test.ts: rewriteArchiveLinks (absolute+relative), rewriteCssUrls, stripWaybackToolbar, sanitizeTimeParam, collectWaybackResourceUrls, unwrapNestedProxyUrl
- [ ] Tests green

## Work Log

