---
id: 002-c7d9
title: Refactor HTTP handler to delegate to proxyFetch
status: complete
priority: P1
created: "2026-05-20T01:51:42.193Z"
updated: "2026-05-20T02:15:31.989Z"
dependencies: []
---

# Refactor HTTP handler to delegate to proxyFetch

## Problem Statement

The HTTP handler (timemachine.ts:912-999) contains a full inline reimplementation of the same fetch-cache-rewrite pipeline that already exists in proxyFetch (lines 661-778). proxyFetch is only called by the WS handler. Any logic change must be made in two places. The WS nested-URL miss is a direct product of this divergence. ~90 lines of duplicated logic plus sendCached (lines 782-816) which duplicates the cache-hit branch.

## Acceptance Criteria

- [ ] HTTP handler calls proxyFetch and writes ProxyResult to res
- [ ] sendCached function can be removed (functionality absorbed into proxyFetch delegation)
- [ ] WS handler continues to call proxyFetch directly (no change needed)
- [ ] No behavioral regression on HTTP responses (headers, status codes, body)
- [ ] Cache-hit and cache-miss paths both work correctly via proxyFetch

## Work Log

### 2026-05-20T02:15:31.842Z - HTTP handler now delegates to proxyFetch. sendCached removed (~34 lines dead code). ~99 lines of inline fetch logic replaced with ~22 line delegation. Typecheck clean.

