---
id: 003-5bdf
title: Merge package.json with main
status: complete
priority: P2
type: chore
created: "2026-05-22T00:21:47.764Z"
updated: "2026-05-22T00:57:37.433Z"
dependencies: []
started_at: "2026-05-22T00:50:01.587Z"
completed_at: "2026-05-22T00:57:37.432Z"
---

# Merge package.json with main

## Problem Statement

Both sides touched package.json for URL rewriter work. Main: 35d5262 'URL rewriter'. Branch: a88c5d6 'path-based URL rewriting'. Likely different dep additions (e.g. parse5 / htmlparser2 etc.). Lockfile (pnpm-lock.yaml) merge depends on this.

## Acceptance Criteria

- [x] Diff of dependencies/devDependencies/scripts between branch and main reviewed with Boss
- [x] Final package.json carries the dependency set required by the chosen url-rewriter.ts implementation
- [x] Scripts (build/test/typecheck) work on the merged tree
- [x] pnpm install completes without resolution warnings unrelated to the merge

## Files

- package.json

## Related

- pnpm-lock.yaml merge
- src/lib/url-rewriter.ts merge

## QA

None — baseline pnpm test (270 tests) confirms lockfile/package.json are consistent

## Work Log

### 2026-05-22T00:57:32.869Z - Branch's package.json already matches the chosen url-rewriter direction (parse5; #007-7e79 confirmed branch-base + main-coverage). Only diff vs main is node-html-parser↔parse5. Lockfile already consistent (270-test baseline passes). No file changes needed for this story.

