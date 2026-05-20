---
id: 018-cb62
title: "Fix graceful shutdown: terminate WS clients before server.close()"
status: complete
priority: P3
created: "2026-05-20T01:54:10.879Z"
updated: "2026-05-20T02:23:19.005Z"
dependencies: []
---

# Fix graceful shutdown: terminate WS clients before server.close()

## Problem Statement

timemachine.ts:1160 — wss.close() stops accepting new connections but does not terminate existing WebSocket clients. server.close() callback never fires while clients remain connected, so process.exit(0) is never reached. Cloud Run will force-kill the container after its deadline.

## Acceptance Criteria

- [ ] Before calling server.close(), iterate wss.clients and call ws.terminate() on each
- [ ] server.close() callback fires promptly after all connections are closed
- [ ] Existing shutdownController.abort() and archiveQueue.abort() calls remain unchanged

## Work Log

### 2026-05-20T02:23:18.847Z - shutdown() now terminates all WS clients before wss.close() so server.close() callback fires

