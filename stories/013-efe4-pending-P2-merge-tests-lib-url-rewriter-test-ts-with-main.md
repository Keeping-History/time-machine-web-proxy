---
id: 013-efe4
title: Merge tests/lib/url-rewriter.test.ts with main
status: pending
priority: P2
type: refactor
created: "2026-05-22T00:21:47.766Z"
updated: "2026-05-22T00:22:09.432Z"
dependencies: ["007-7e79"]
---

# Merge tests/lib/url-rewriter.test.ts with main

## Problem Statement

Tests for the URL rewriter. Branch (a88c5d6) tests path-based rewriting against branch's API (parseWaybackPath/rewriteOneUrl). Main (35d5262) tests its own API (rewriteHtmlUrls/toProxyUrl). Whichever url-rewriter.ts implementation wins, the losing side's tests must be ported or rewritten.

## Acceptance Criteria

- [ ] src/lib/url-rewriter.ts merge story completed first
- [ ] Test file targets the chosen implementation's public API exclusively
- [ ] Behavioral cases from BOTH sides (toolbar strip, srcset rewriting, CSS url(), path-based handling, sanitizeTimeParam, unwrapNestedProxyUrl) are covered — even if the API shape differs
- [ ] `pnpm test tests/lib/url-rewriter.test.ts` passes against merged code

## Files

- tests/lib/url-rewriter.test.ts

## Related

- src/lib/url-rewriter.ts merge

## Work Log

