---
id: "003-5bdf"
title: "Merge package.json with main"
status: pending
priority: P2
type: chore
created: 2026-05-22T00:21:47.764Z
updated: 2026-05-22T00:21:47.764Z
dependencies: []
---

# Merge package.json with main

## Problem Statement

Both sides touched package.json for URL rewriter work. Main: 35d5262 'URL rewriter'. Branch: a88c5d6 'path-based URL rewriting'. Likely different dep additions (e.g. parse5 / htmlparser2 etc.). Lockfile (pnpm-lock.yaml) merge depends on this.

## Acceptance Criteria

- [ ] Diff of dependencies/devDependencies/scripts between branch and main reviewed with Boss
- [ ] Final package.json carries the dependency set required by the chosen url-rewriter.ts implementation
- [ ] Scripts (build/test/typecheck) work on the merged tree
- [ ] pnpm install completes without resolution warnings unrelated to the merge

## Files

- package.json

## Related

- pnpm-lock.yaml merge
- src/lib/url-rewriter.ts merge

## Work Log

