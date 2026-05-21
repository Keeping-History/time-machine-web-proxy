---
id: 004-9783
title: Integrate snapshot resolver into archive worker — fix from/to timestamp bug
status: complete
priority: P1
type: fix
created: "2026-05-21T22:26:59.316Z"
updated: "2026-05-21T22:41:06.561Z"
dependencies: ["001-9d80", "002-5dee", "003-22c8"]
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 4
started_at: "2026-05-21T22:37:15.625Z"
completed_at: "2026-05-21T22:41:06.561Z"
---

# Integrate snapshot resolver into archive worker — fix from/to timestamp bug

## Problem Statement

archive-worker.ts passes from_timestamp=to_timestamp=requestedTime causing Wayback CDX to return 0 results for any timestamp that was not crawled at that exact second. The worker must resolve the closest real snapshot timestamp before invoking the downloader.

## Acceptance Criteria

- [x] Exact processor calls resolver with correct variants and requestedTime before constructing WaybackMachineDownloader
- [x] When resolver returns null: writeNotFoundSentinel is called, downloader is NOT invoked, processor returns successfully
- [x] When resolver returns a timestamp: downloader called with from_timestamp=to_timestamp=resolvedTimestamp
- [x] Worker logs {url, time, resolved} at info level on successful resolution
- [x] Worker logs {url, time} at warn level on null resolution
- [x] Crawl processor gets the same resolver/sentinel treatment for its host root URL
- [x] npx jest tests/queue/archive-worker.test.ts passes

## Files

- src/queue/archive-worker.ts
- tests/queue/archive-worker.test.ts

## QA

None — covered by 9 new worker tests

## Work Log

### 2026-05-21T22:41:04.925Z - Worker now awaits resolver(variants, time) before downloader. On null: writeNotFoundSentinel + return successfully (no throw → no BullMQ retry). On resolved: downloader called with from=to=resolved (the actual fix for the from==to bug). Crawl processor mirrors the same flow, keyed to https://<host>/ as the sentinel URL. Added StartArchiveWorkersOpts.resolver of type SnapshotResolverFn; Dependencies wired with a temporary identity stub (DEFERRED tag) — story 005-a8ed swaps in the real closure. 7 new worker tests + 2 microtask-flush adjustments to crawl fake-timer tests.

