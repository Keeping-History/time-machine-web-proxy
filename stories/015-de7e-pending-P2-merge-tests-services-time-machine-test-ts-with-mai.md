---
id: 015-de7e
title: Merge tests/services/time-machine.test.ts with main
status: pending
priority: P2
type: refactor
created: "2026-05-22T00:21:47.767Z"
updated: "2026-05-22T00:22:09.665Z"
dependencies: ["010-8822", "007-7e79", "005-d125"]
---

# Merge tests/services/time-machine.test.ts with main

## Problem Statement

Integration tests for the proxy service. Branch (a88c5d6 path-based URL rewriting, d6f9d78 config envs) and main (58ad5d2, 05ee70b, 6297960 proxy/deployment) both updated this file. Final test shape depends on proxy.ts, url-rewriter.ts, and config.ts merge outcomes.

## Acceptance Criteria

- [ ] src/services/proxy.ts, src/lib/url-rewriter.ts, and src/lib/config.ts merge stories completed first
- [ ] Integration tests cover the merged proxy surface end-to-end: cache lookup → fetch → rewrite → response
- [ ] X-Archive-Time header asserted (if branch's header survives the proxy merge)
- [ ] Path-based URL handling asserted (if branch's parseWaybackPath survives the url-rewriter merge)
- [ ] Main's behavioral cases for proxy/deployment paths ported where applicable
- [ ] `pnpm test tests/services/time-machine.test.ts` passes against merged code

## Files

- tests/services/time-machine.test.ts

## Related

- src/services/proxy.ts merge
- src/lib/url-rewriter.ts merge
- src/lib/config.ts merge

## Work Log

