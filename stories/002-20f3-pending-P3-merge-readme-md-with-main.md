---
id: 002-20f3
title: Merge README.md with main
status: pending
priority: P3
type: chore
created: "2026-05-22T00:21:47.763Z"
updated: "2026-05-22T00:22:09.782Z"
dependencies: ["005-d125"]
---

# Merge README.md with main

## Problem Statement

Branch added SNAPSHOT_WINDOW_DAYS / ALLOW_LATER_FALLBACK / on-or-before docs (98570a1). Main has multiple proxy/deployment doc updates (58ad5d2, 05ee70b, 6297960). Both edits are doc-shaped, likely co-existable but must be reviewed for inconsistent claims.

## Acceptance Criteria

- [ ] Both sides' README changes reviewed with Boss and merge direction confirmed
- [ ] Final README documents SNAPSHOT_WINDOW_DAYS and ALLOW_LATER_FALLBACK (from branch) if those env vars survive the merge of config.ts
- [ ] Final README documents deployment/proxy changes from main (no regressions)
- [ ] No contradictory statements about behavior between sections

## Files

- README.md

## Related

- src/lib/config.ts merge
- src/models/config.ts merge

## Work Log

