---
id: 007-7e79
title: Merge src/lib/url-rewriter.ts with main
status: pending
priority: P1
type: refactor
created: "2026-05-22T00:21:47.765Z"
updated: "2026-05-22T00:22:08.826Z"
dependencies: ["003-5bdf"]
---

# Merge src/lib/url-rewriter.ts with main

## Problem Statement

Parallel reimplementations, not a stale-vs-current case. Main (35d5262, 280 lines) exports `rewriteHtmlUrls`, `toProxyUrl`, `URL_ATTRS_BY_TAG` (Map). Branch (a88c5d6, 190 lines) exports `parseWaybackPath`, `rewriteOneUrl`, `TAG_URL_ATTRS` (Record). Different API surfaces — picking one breaks the other side's callers. Boss must choose the canonical implementation.

## Acceptance Criteria

- [ ] Both implementations diffed and behaviors compared with Boss; canonical implementation chosen
- [ ] If main wins: branch's path-based handling (parseWaybackPath) ported on top or explicitly dropped with rationale
- [ ] If branch wins: main's wayback-prefix handling / sanitizeTimeParam / unwrapNestedProxyUrl behaviors ported or kept
- [ ] Public API surface used by src/services/proxy.ts updated to match the chosen implementation
- [ ] tests/lib/url-rewriter.test.ts merge story completed and passing
- [ ] No regression in toolbar-stripping or URL rewriting on a manual proxy fetch

## Files

- src/lib/url-rewriter.ts

## Related

- src/services/proxy.ts merge
- tests/lib/url-rewriter.test.ts merge
- package.json merge

## Work Log

