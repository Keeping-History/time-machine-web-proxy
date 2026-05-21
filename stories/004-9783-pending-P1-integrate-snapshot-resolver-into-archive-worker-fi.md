---
id: 004-9783
title: Integrate snapshot resolver into archive worker — fix from/to timestamp bug
status: pending
priority: P1
type: fix
created: "2026-05-21T22:26:59.316Z"
updated: "2026-05-21T22:27:06.580Z"
dependencies: ["001-9d80", "002-5dee", "003-22c8"]
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 4
---

# Integrate snapshot resolver into archive worker — fix from/to timestamp bug

## Problem Statement

archive-worker.ts passes from_timestamp=to_timestamp=requestedTime causing Wayback CDX to return 0 results for any timestamp that was not crawled at that exact second. The worker must resolve the closest real snapshot timestamp before invoking the downloader.

## Acceptance Criteria

- [ ] Exact processor calls resolver with correct variants and requestedTime before constructing WaybackMachineDownloader
- [ ] When resolver returns null: writeNotFoundSentinel is called, downloader is NOT invoked, processor returns successfully (no throw, no BullMQ retry)
- [ ] When resolver returns a timestamp: downloader called with from_timestamp=to_timestamp=resolvedTimestamp (not requestedTime)
- [ ] Worker logs {url, time, resolved} at info level on successful resolution
- [ ] Worker logs {url, time} at warn level on null resolution (no snapshot found)
- [ ] Crawl processor gets the same resolver/sentinel treatment for its host root URL
- [ ] npx jest tests/queue/archive-worker.test.ts passes

## Files

- src/queue/archive-worker.ts
- tests/queue/archive-worker.test.ts

## Work Log

