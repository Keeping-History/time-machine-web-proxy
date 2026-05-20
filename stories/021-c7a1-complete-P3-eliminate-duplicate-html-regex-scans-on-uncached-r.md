---
id: 021-c7a1
title: Eliminate duplicate HTML regex scans on uncached responses
status: complete
priority: P3
created: "2026-05-20T01:54:30.144Z"
updated: "2026-05-20T02:23:20.028Z"
dependencies: []
---

# Eliminate duplicate HTML regex scans on uncached responses

## Problem Statement

timemachine.ts:455,558 — For a fresh HTML fetch, prefetchResources calls collectWaybackResourceUrls (4 regex passes over the HTML) to find resource URLs. Then rewriteImageUrlsFiltered and rewriteCssUrlsFiltered run replace over the same HTML with the same four patterns. The HTML is scanned twice by identical patterns on every uncached response.

## Acceptance Criteria

- [ ] On the uncached HTML path, reuse the URL list from collectWaybackResourceUrls to drive prefetching rather than scanning again
- [ ] Or combine the collection and rewriting into a single pass
- [ ] No change to correctness or background prefetch behavior

## Work Log

### 2026-05-20T02:23:19.861Z - Extracted prefetchResourceUrls helper; uncached path collects resource URLs once and passes to both prefetch and rewrite

