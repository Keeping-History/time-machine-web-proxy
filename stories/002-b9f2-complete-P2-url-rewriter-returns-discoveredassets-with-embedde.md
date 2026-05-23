---
id: 002-b9f2
title: url-rewriter returns discoveredAssets with embedded timestamps
status: complete
priority: P2
type: feature
created: "2026-05-23T01:01:40.155Z"
updated: "2026-05-23T01:07:51.079Z"
dependencies: []
plan: plans/direct-fetch-fast-path.md
plan_step: Step 2
completed_at: "2026-05-23T01:07:51.078Z"
---

# url-rewriter returns discoveredAssets with embedded timestamps

## Problem Statement

Rewriter currently discards Wayback's embedded resolved timestamps captured by RE_ARCHIVE_URL. Capture (originalUrl, embeddedTs) pairs from HTML/CSS during parse so prewarm can use them to skip CDX.

## Acceptance Criteria

- [x] rewriteHtmlUrls returns { html, discoveredAssets } shape; existing callers can ignore discoveredAssets
- [x] Embedded TS in /web/<ts>im_/<url> appears in discoveredAssets with { url, embeddedTs }
- [x] Plain relative URL without embedded TS is rewritten but not added to discoveredAssets
- [x] Duplicate refs (same url+ts twice) deduplicate to a single entry
- [x] Malformed embedded TS (non-14-digit) drops the entry, does not crash
- [x] Same coverage applies to srcset, inline style elements, style attributes, meta http-equiv refresh, and rewriteCssUrls for CSS files
- [x] pnpm test url-rewriter.test.ts green

## Files

- src/lib/url-rewriter.ts
- tests/lib/url-rewriter.test.ts

## QA

None — covered by automated tests (299 passing in url-rewriter.test.ts, 1290 total)

## Work Log

### 2026-05-23T01:07:27.682Z - Completed: rewriteHtmlUrls now returns { html, discoveredAssets } with embedded TS extraction

