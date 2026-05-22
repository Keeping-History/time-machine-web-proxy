---
id: 004-ebe5
title: Merge pnpm-lock.yaml with main
status: pending
priority: P2
type: chore
created: "2026-05-22T00:21:47.764Z"
updated: "2026-05-22T00:22:08.464Z"
dependencies: ["003-5bdf"]
---

# Merge pnpm-lock.yaml with main

## Problem Statement

Lockfile diverged because both sides added URL-rewriter-related deps. Must be regenerated after package.json merge — never hand-edited.

## Acceptance Criteria

- [ ] package.json merge story completed first
- [ ] pnpm-lock.yaml regenerated via `pnpm install --frozen-lockfile=false` against the merged package.json
- [ ] No phantom or orphaned dependencies in the final lockfile
- [ ] `pnpm install --frozen-lockfile` succeeds on a clean checkout after merge

## Files

- pnpm-lock.yaml

## Related

- package.json merge

## Work Log

