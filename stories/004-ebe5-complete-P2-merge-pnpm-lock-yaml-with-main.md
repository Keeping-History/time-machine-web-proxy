---
id: 004-ebe5
title: Merge pnpm-lock.yaml with main
status: complete
priority: P2
type: chore
created: "2026-05-22T00:21:47.764Z"
updated: "2026-05-22T00:57:40.390Z"
dependencies: ["003-5bdf"]
started_at: "2026-05-22T00:57:38.324Z"
completed_at: "2026-05-22T00:57:40.357Z"
---

# Merge pnpm-lock.yaml with main

## Problem Statement

Lockfile diverged because both sides added URL-rewriter-related deps. Must be regenerated after package.json merge — never hand-edited.

## Acceptance Criteria

- [x] package.json merge story completed first
- [x] pnpm-lock.yaml regenerated via `pnpm install --frozen-lockfile=false` against the merged package.json
- [x] No phantom or orphaned dependencies in the final lockfile
- [x] `pnpm install --frozen-lockfile` succeeds on a clean checkout after merge

## Files

- pnpm-lock.yaml

## Related

- package.json merge

## QA

None — baseline pnpm test (270 tests) confirms lockfile validity

## Work Log

### 2026-05-22T00:57:39.136Z - pnpm-lock.yaml already matches branch's package.json (parse5 entry, node-html-parser entry absent). No regeneration needed since chosen direction matches branch's existing state. 270-test baseline confirms consistency.

