---
id: 019-1559
title: Fix inconsistent indentation in HTTP handler
status: wontfix
priority: P3
created: "2026-05-20T01:54:17.224Z"
updated: "2026-05-20T02:23:19.353Z"
dependencies: []
---

# Fix inconsistent indentation in HTTP handler

## Problem Statement

timemachine.ts:797,944,973 — Several lines in sendCached and the HTTP handler have extra leading tabs inconsistent with surrounding code. Lines 944 and 973 (const html/css = await fetchRes.text()) are indented with 5 tabs while their enclosing if blocks use 3. Line 797 in sendCached has the same issue. Likely copy-paste artifacts.

## Acceptance Criteria

- [ ] Run prettier or dprint formatter on timemachine.ts
- [ ] Verify no logic changes (formatter only adjusts whitespace)
- [ ] All affected lines (797, 812, 944, 973) match surrounding indentation level

## Work Log

### 2026-05-20T02:23:19.190Z - Wontfix: no formatter configured; CLAUDE.md requires a formatting tool for whitespace-only changes

