---
id: "001-c1cf"
title: "Cover runtime-shim wayback unwrap + worker sentinel-filter watcher"
status: pending
priority: P2
type: task
created: 2026-05-23T04:31:59.922Z
updated: 2026-05-23T04:31:59.922Z
dependencies: []
---

# Cover runtime-shim wayback unwrap + worker sentinel-filter watcher

## Problem Statement

Recent fixes added two code paths without test coverage: (1) runtime-shim.ts WAYBACK_ABS_RE branch that unwraps absolute/protocol-relative wayback URLs set at runtime via href/src/document.write/fetch/XHR; (2) startDownloadWatcher filter in archive-worker.ts that ignores .notfound/ and .notfound-tentative/ subpaths so concurrent jobs writing sentinels do not pollute another job download_file progress events. Both are behaviorally correct in production logs (IBM ibmcss.js → r1.css now loads; sentinel files no longer appear in worker progress) but have zero test coverage, leaving regressions invisible.

## Acceptance Criteria

- [ ] runtime-shim tests cover absolute http(s)://web.archive.org/web/<ts>[mod_]/<url> unwrapping in: window.fetch, XMLHttpRequest.open, HTMLLinkElement.href setter, HTMLImageElement.src setter, document.write, and MutationObserver dynamic insert
- [ ] runtime-shim tests cover protocol-relative //web.archive.org/web/<ts>[mod_]/<url> unwrapping in at least one entry point
- [ ] runtime-shim tests assert the embedded timestamp (not the page timestamp) wins when unwrapping
- [ ] runtime-shim tests confirm /web/<ts>/<url> path-form input is still pass-through (no double unwrap)
- [ ] archive-worker test covers startDownloadWatcher: file events for .notfound/<hash> and .notfound-tentative/<hash> are silently dropped (no onFile call, filesSeen count unchanged)
- [ ] archive-worker test covers that legitimate downloads (e.g. pics/sunlogo.gif) still fire onFile after the filter
- [ ] All new tests fail against pre-fix code (regex absent in shim, no filter in watcher) and pass after — proving they exercise real behaviour not stubs

## Files

- src/lib/runtime-shim.ts:24-33
- src/queue/archive-worker.ts:117-132
- tests/lib/runtime-shim.test.ts
- tests/queue/archive-worker.test.ts

## Work Log

