---
id: 010-7232
title: Hoist parseWhitelist result to module scope
status: complete
priority: P2
created: "2026-05-20T01:53:02.885Z"
updated: "2026-05-20T02:18:12.825Z"
dependencies: []
---

# Hoist parseWhitelist result to module scope

## Problem Statement

timemachine.ts:69 — isHostWhitelisted calls parseWhitelist(whitelistHosts) on every HTTP and WS request, creating and discarding a new array each time. whitelistHosts is a module-level constant that never changes. Minor CPU waste but mainly an unnecessary allocation on every request.

## Acceptance Criteria

- [ ] Parse whitelistHosts once at module initialization into parsedWhitelist constant
- [ ] isHostWhitelisted uses the module-level parsed array instead of calling parseWhitelist each time
- [ ] parseWhitelist function can be removed or kept as a pure utility — no call sites needed at runtime

## Work Log

### 2026-05-20T02:18:12.677Z - Hoisted parsedWhitelist = parseWhitelist(whitelistHosts) to module scope; isHostWhitelisted reads parsedWhitelist

