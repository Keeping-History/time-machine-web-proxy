---
id: 015-75c9
title: Log upstream errors in WebSocket handler server-side
status: complete
priority: P2
created: "2026-05-20T01:53:35.916Z"
updated: "2026-05-20T02:21:35.516Z"
dependencies: []
---

# Log upstream errors in WebSocket handler server-side

## Problem Statement

timemachine.ts:1137 — When proxyFetch rejects in the WS handler, the error is serialized and sent to the client but nothing is logged on the server. The HTTP handler logs console.error([TimeMachine] Upstream request failed:, e). Asymmetric observability between HTTP and WS makes production debugging harder.

## Acceptance Criteria

- [ ] WS proxyFetch catch block logs the error server-side before sending the WS error response
- [ ] Log level matches HTTP handler (console.error or console.warn)
- [ ] Log includes request id (msg.id) and targetUrl for correlation

## Work Log

### 2026-05-20T02:21:35.366Z - WS catch now logs status>=500 errors via console.error before sending error response to client

