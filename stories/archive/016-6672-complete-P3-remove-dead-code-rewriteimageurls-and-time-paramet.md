---
id: 016-6672
title: "Remove dead code: _rewriteImageUrls and _time parameter"
status: complete
priority: P3
created: "2026-05-20T01:53:59.780Z"
updated: "2026-05-20T02:03:29.320Z"
dependencies: []
---

# Remove dead code: _rewriteImageUrls and _time parameter

## Problem Statement

timemachine.ts:425 — _rewriteImageUrls is defined with an underscore prefix to suppress unused warnings but is never called anywhere. Its functionality is fully covered by rewriteImageUrlsFiltered. Also timemachine.ts:411 — the _time parameter in rewriteArchiveLinks is named with underscore (intentionally unused) and is never referenced in the function body. All 4 call sites pass time as a dead argument.

## Acceptance Criteria

- [ ] Delete _rewriteImageUrls function (lines 425-440)
- [ ] Remove _time parameter from rewriteArchiveLinks signature
- [ ] Update all 4 call sites of rewriteArchiveLinks to pass only 2 arguments
- [ ] No functional change

## Work Log

### 2026-05-20T02:03:29.173Z - Implemented directly: changes applied and typecheck passes

