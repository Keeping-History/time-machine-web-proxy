---
id: 003-42c7
title: Fix DELETE /cache unauthenticated when CACHE_CLEAR_TOKEN is unset
status: complete
priority: P1
created: "2026-05-20T01:51:50.163Z"
updated: "2026-05-20T02:03:48.101Z"
dependencies: []
---

# Fix DELETE /cache unauthenticated when CACHE_CLEAR_TOKEN is unset

## Problem Statement

The DELETE /cache endpoint only enforces auth when cacheClearToken is non-empty (if (cacheClearToken) { ... }). When CACHE_CLEAR_TOKEN is unset (the default), the entire auth block is skipped and any unauthenticated caller can wipe the entire cache. This is a DoS vector forcing expensive Wayback Machine re-fetches and triggering rate limiting.

## Acceptance Criteria

- [ ] When CACHE_CLEAR_TOKEN is unset, DELETE /cache returns 403 with a clear message (not 401)
- [ ] When CACHE_CLEAR_TOKEN is set, correct Bearer token is required as before
- [ ] Startup log indicates whether cache management is enabled or disabled
- [ ] No change to behavior when token is correctly set

## Work Log

### 2026-05-20T02:03:47.954Z - Auth bypass fixed: 403 when CACHE_CLEAR_TOKEN unset, cacheManagement in startup log. Typecheck passed.

