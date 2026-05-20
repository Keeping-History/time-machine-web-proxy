---
id: 013-c9fd
title: Add concurrency cap to handleCacheClear Promise.all
status: complete
priority: P2
created: "2026-05-20T01:53:22.240Z"
updated: "2026-05-20T02:21:34.848Z"
dependencies: []
---

# Add concurrency cap to handleCacheClear Promise.all

## Problem Statement

timemachine.ts:612 — handleCacheClear reads every .json file in the cache directory with unbounded Promise.all, loading all HTML/binary bodies into the heap simultaneously. On a large GCS FUSE cache this can exhaust memory and create an I/O burst.

## Acceptance Criteria

- [ ] Process cache files in batches with a concurrency limit (e.g. 20 concurrent reads)
- [ ] Use a simple manual chunking loop or a p-limit equivalent (no new dependencies — implement inline)
- [ ] Total deleted/errors counts remain accurate
- [ ] No change to the response format

## Work Log

### 2026-05-20T02:21:34.695Z - handleCacheClear now processes cache files in batches of 20 instead of unbounded Promise.all

