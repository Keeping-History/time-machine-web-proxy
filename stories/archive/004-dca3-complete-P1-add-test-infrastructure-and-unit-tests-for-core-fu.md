---
id: "004-dca3"
title: "Add test infrastructure and unit tests for core functions"
status: complete
priority: P1
created: 2026-05-20T01:51:59.015Z
updated: 2026-05-20
dependencies: []
---

# Add test infrastructure and unit tests for core functions

## Problem Statement

Zero test infrastructure exists. No test runner, no test files, no test script. Every security-critical function (validateTargetUrl, sanitizeTimeParam, isHostWhitelisted) and the URL-rewrite pipeline are completely untested. The nested proxy URL fix on this branch has no regression protection.

## Acceptance Criteria

- [ ] Add vitest as dev dependency (zero-config, native ESM+TypeScript)
- [ ] Add test script to package.json
- [ ] Unit tests for validateTargetUrl: blocks private IPs (127.x, 10.x, 192.168.x, 169.254.x, ::1), blocks non-http protocols, allows public URLs
- [ ] Unit tests for sanitizeTimeParam: valid 14-digit format, null returns default, invalid throws
- [ ] Unit tests for sanitizeTimeParam: rejects path traversal and non-numeric input
- [ ] Unit tests for isHostWhitelisted: wildcard matching, exact match, empty list
- [ ] Unit tests for nested proxy URL unwrap logic: correct unwrap, wrong hostname no-op, inner time propagation
- [ ] Unit tests for stripWaybackToolbar: removes toolbar, injects base tag, escapes URL chars

## Work Log

