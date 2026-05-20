---
id: 012-550c
title: Add maximum queue depth to ArchiveRequestQueue
status: complete
priority: P2
created: "2026-05-20T01:53:15.969Z"
updated: "2026-05-20T02:21:34.519Z"
dependencies: []
---

# Add maximum queue depth to ArchiveRequestQueue

## Problem Statement

timemachine.ts:264 — ArchiveRequestQueue.queue has no size cap. Under sustained load or Wayback Machine slowdowns, requests pile up without bound. Each entry holds a closure and a pending Response promise, creating unbounded memory growth.

## Acceptance Criteria

- [ ] Add maxQueueSize constructor parameter (default e.g. 500)
- [ ] When queue is at capacity, enqueue() rejects immediately with a 503-typed error
- [ ] The rejection message is distinguishable from other errors so the HTTP/WS handler can return 503 Service Unavailable
- [ ] No change to behavior when queue is below capacity

## Work Log

### 2026-05-20T02:21:34.364Z - Added maxQueueSize (default 200) to ArchiveRequestQueue; enqueue rejects with status 503 when exceeded

