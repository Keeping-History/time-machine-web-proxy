---
id: 014-4544
title: Replace unsafe JSON.parse as-casts with structural validation
status: complete
priority: P2
created: "2026-05-20T01:53:29.783Z"
updated: "2026-05-20T02:21:35.186Z"
dependencies: []
---

# Replace unsafe JSON.parse as-casts with structural validation

## Problem Statement

timemachine.ts:129,619,1054 — JSON.parse results are cast directly to CacheEntry and WsRequest without runtime validation. Corrupt cache files or malformed WS messages proceed with potentially undefined fields. Adding zod conflicts with the lean-bundle rule.

## Acceptance Criteria

- [ ] Add lightweight structural check for CacheEntry after JSON.parse: verify body is string, isHtml and isCss are booleans, contentType is string
- [ ] Add lightweight structural check for WsRequest after JSON.parse: verify type and url are strings if present
- [ ] On validation failure for CacheEntry, treat as cache miss (return null from cacheGet)
- [ ] On validation failure for WsRequest, return error response (already partially handled by type/url check at line 1065)
- [ ] No zod or external validation library — inline checks only

## Work Log

### 2026-05-20T02:21:35.029Z - Added isCacheEntry and isWsRequest type guards; replaced unsafe JSON.parse as-casts with runtime checks

