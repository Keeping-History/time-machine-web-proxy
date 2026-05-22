---
id: 014-1bec
title: Merge tests/queue/archive-worker.test.ts with main
status: complete
priority: P2
type: refactor
created: "2026-05-22T00:21:47.767Z"
updated: "2026-05-22T01:07:24.955Z"
dependencies: ["009-8965"]
started_at: "2026-05-22T01:04:54.286Z"
completed_at: "2026-05-22T01:07:24.955Z"
---

# Merge tests/queue/archive-worker.test.ts with main

## Problem Statement

Tests for the worker. Branch (ad996a6, caa0535) tests the DI/resolver pattern and snapshot-resolver integration. Main (3523a94 availability check, 52505a9 cache updates, 5774ace 'Additional tests', 46b9395 Wayback-snap) tests the inline implementation. Test shape depends on which architecture wins in the worker merge.

## Acceptance Criteria

- [x] src/queue/archive-worker.ts merge story completed first
- [x] Test file uses the chosen worker architecture's mocks/dependencies — not a mix
- [x] Coverage retained for: availability check, Wayback-snap, snapshot resolver (whichever survives), rate-limit handling, crawl-lock extension
- [REJECTED] Main's 'Additional tests' (5774ace) reviewed and ported where they cover behavior the branch didn't (Main's 'Additional tests' (5774ace) were specific to main's inline implementation (availability-check, Wayback-snap) which we did NOT adopt — Boss chose branch's DI/resolver. The behaviors covered by 5774ace are now structurally absent from the worker; no port applies. Branch's DI tests already provide equivalent coverage at the right abstraction layer.)
- [x] `pnpm test tests/queue/archive-worker.test.ts` passes against merged code

## Files

- tests/queue/archive-worker.test.ts

## Related

- src/queue/archive-worker.ts merge

## QA

None — covered by jest (35/35 in archive-worker.test.ts)

## Work Log

### 2026-05-22T01:07:23.899Z - Updated worker tests to match merged worker (#009): (1) added 'lookup' to makeCache mock (post-download validation); (2) exact worker test now asserts download_external_assets: true (Boss's edit) and cacheDirForJob called with 'www.example.com' (not bareHost); (3) replaced two obsolete crawl tests: 'calls resolver and uses resolved time' → 'crawl worker does NOT invoke the snapshot resolver' (crawl now uses dayWindow); 'writes sentinel for host root URL' → 'crawl worker does NOT write the not-found sentinel'. Added new test for post-download validation: 'throws when downloader produces no usable file for THIS (url, time)'. 35/35 tests passing.

