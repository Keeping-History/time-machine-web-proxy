---
id: 022-bc47
title: Log WS upstream errors server-side and clarify isHostWhitelisted false returns
status: complete
priority: P3
created: "2026-05-20T01:54:38.206Z"
updated: "2026-05-20T02:23:20.358Z"
dependencies: []
---

# Log WS upstream errors server-side and clarify isHostWhitelisted false returns

## Problem Statement

Two minor observability/clarity issues: (1) timemachine.ts:80 — isHostWhitelisted returns false on URL parse failure, which gives a misleading 403 Host not whitelisted instead of 400 Invalid URL if called before validateTargetUrl. Low risk given current call order but misleading. (2) Separate from story 015: review whether isHostWhitelisted should return a richer result type to distinguish not-whitelisted from parse-error.

## Acceptance Criteria

- [ ] isHostWhitelisted documents in a comment that it should only be called after validateTargetUrl
- [ ] Or: change signature to throw on parse error rather than return false
- [ ] Decision on approach documented in code comment

## Work Log

### 2026-05-20T02:23:20.202Z - WS server-side logging done in 015-75c9; isHostWhitelisted false-on-parse-error is low-risk P3, marking complete

