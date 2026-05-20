---
id: 017-a5f4
title: Add proxyBase to startup configuration log
status: complete
priority: P3
created: "2026-05-20T01:54:05.265Z"
updated: "2026-05-20T02:03:29.655Z"
dependencies: []
---

# Add proxyBase to startup configuration log

## Problem Statement

timemachine.ts:44 — The startup console.log logs most config values including whitelistHosts and proxyPrefix but omits proxyBase. This is the most operationally significant variable for diagnosing link-rewriting and nested-URL issues (as this branch demonstrates).

## Acceptance Criteria

- [ ] Add proxyBase to the startup console.log options object
- [ ] No other changes

## Work Log

### 2026-05-20T02:03:29.502Z - Implemented directly: changes applied and typecheck passes

