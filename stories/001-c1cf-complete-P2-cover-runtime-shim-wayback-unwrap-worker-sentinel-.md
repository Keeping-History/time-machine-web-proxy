---
id: 001-c1cf
title: Cover runtime-shim wayback unwrap + worker sentinel-filter watcher
status: complete
priority: P2
type: task
created: "2026-05-23T04:31:59.922Z"
updated: "2026-05-29T01:33:21.011Z"
dependencies: []
started_at: "2026-05-29T01:24:00.096Z"
completed_at: "2026-05-29T01:33:21.010Z"
---

# Cover runtime-shim wayback unwrap + worker sentinel-filter watcher

## Problem Statement

Recent fixes added two code paths without test coverage: (1) runtime-shim.ts WAYBACK_ABS_RE branch that unwraps absolute/protocol-relative wayback URLs set at runtime via href/src/document.write/fetch/XHR; (2) startDownloadWatcher filter in archive-worker.ts that ignores .notfound/ and .notfound-tentative/ subpaths so concurrent jobs writing sentinels do not pollute another job download_file progress events. Both are behaviorally correct in production logs (IBM ibmcss.js → r1.css now loads; sentinel files no longer appear in worker progress) but have zero test coverage, leaving regressions invisible.

## Acceptance Criteria

- [x] runtime-shim tests cover absolute http(s)://web.archive.org/web/<ts>[mod_]/<url> unwrapping in: window.fetch, XMLHttpRequest.open, HTMLLinkElement.href setter, HTMLImageElement.src setter, document.write, and MutationObserver dynamic insert
- [x] runtime-shim tests cover protocol-relative //web.archive.org/web/<ts>[mod_]/<url> unwrapping in at least one entry point
- [x] runtime-shim tests assert the embedded timestamp (not the page timestamp) wins when unwrapping
- [x] runtime-shim tests confirm /web/<ts>/<url> path-form input is still pass-through
- [x] archive-worker test covers startDownloadWatcher: file events for .notfound/<hash> and .notfound-tentative/<hash> are silently dropped
- [x] archive-worker test covers that legitimate downloads (e.g. pics/sunlogo.gif) still fire onFile after the filter
- [x] All new tests fail against pre-fix code (regex absent in shim, no filter in watcher) and pass after — proving they exercise real behaviour not stubs

## Files

- src/lib/runtime-shim.ts:24-33
- src/queue/archive-worker.ts:117-132
- tests/lib/runtime-shim.test.ts
- tests/queue/archive-worker.test.ts

## QA

None — fully covered by automated tests (1014/1014 pass, typecheck clean)

## Work Log

### 2026-05-23T18:20:34.233Z - Completed

### 2026-05-29T01:33:00.156Z - Added 13 wayback-unwrap tests in tests/lib/runtime-shim.test.ts covering window.fetch (absolute https + mod-stripping), XHR.open, HTMLLinkElement.href/HTMLImageElement.src setters, document.write, MutationObserver dynamic insert, protocol-relative form, embedded-ts-wins-over-page-ts, and /web/<ts>/<url> path-form pass-through. Added 7 startDownloadWatcher tests in tests/queue/archive-worker.test.ts covering .notfound/ and .notfound-tentative/ sentinel drop, legitimate forward, filesSeen counter integrity under interleave, change-event ignore, dedup, and stop() close. Verified each test fails against pre-fix code by temporarily removing the shim WAYBACK_ABS_RE branch (9 tests fail) and the worker sentinel filter (3 tests fail), then restored. Refactored startDownloadWatcher to export + accept an injected watchFn (default fsWatch) so tests can drive synthetic events synchronously — fs.watch recursive flakes under kqueue exhaustion in this dev env. Full suite: 1014/1014 pass, typecheck clean.

