---
id: 001-7ab0
title: Fix WebSocket handler missing nested proxy URL unwrap
status: complete
priority: P1
created: "2026-05-20T01:51:34.574Z"
updated: "2026-05-20T02:06:12.565Z"
dependencies: []
---

# Fix WebSocket handler missing nested proxy URL unwrap

## Problem Statement

The branch fix-nested-proxy-url-port-check applies the nested proxy URL unwrap only to the HTTP handler. The WebSocket handler calls validateTargetUrl(msg.url) directly without unwrapping. A WS client sending a rewritten proxy link hits PRIVATE_HOST_RE and gets a 403 instead of being proxied correctly. The fix must: extract the unwrap into a shared helper, hoist new URL(proxyBase).hostname to module scope, and apply the helper to both HTTP and WS handlers before validateTargetUrl.

## Acceptance Criteria

- [ ] Extract unwrap into shared unwrapNestedProxyUrl(url, fallbackTime) helper returning {url, time}
- [ ] Helper also extracts inner time param from nested URL, falling back to outer request time
- [ ] Hoist new URL(proxyBase).hostname to module scope (computed once at startup)
- [ ] Call helper from HTTP handler before validateTargetUrl
- [ ] Call helper from WS message handler before validateTargetUrl
- [ ] Both transports behave identically for nested proxy URLs

## Work Log

### 2026-05-20T02:06:12.164Z - Implemented: unwrapNestedProxyUrl helper extracted, hoisted proxyBaseHostname to module scope, applied to both HTTP and WS handlers. Typecheck clean.

