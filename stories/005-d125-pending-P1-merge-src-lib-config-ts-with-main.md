---
id: "005-d125"
title: "Merge src/lib/config.ts with main"
status: pending
priority: P1
type: refactor
created: 2026-05-22T00:21:47.764Z
updated: 2026-05-22T00:21:47.764Z
dependencies: []
---

# Merge src/lib/config.ts with main

## Problem Statement

Branch (d6f9d78) added SNAPSHOT_WINDOW_DAYS and ALLOW_LATER_FALLBACK envs (57 lines). Main (58ad5d2/05ee70b/6297960) has 'Updates to proxy' / 'Deployment updates' touching config (69 lines). Both touched the same config surface — need to confirm which env vars survive.

## Acceptance Criteria

- [ ] Side-by-side diff of branch:src/lib/config.ts vs origin/main:src/lib/config.ts reviewed with Boss
- [ ] Per-key decision recorded for SNAPSHOT_WINDOW_DAYS, ALLOW_LATER_FALLBACK and any main-side additions
- [ ] Final config.ts validates via zod (or equivalent) with no `any`
- [ ] tests/lib/config.test.ts merge story completed and passing against the merged config
- [ ] All consumers of removed/renamed env vars updated

## Files

- src/lib/config.ts

## Related

- src/models/config.ts merge
- tests/lib/config.test.ts merge
- README.md merge

## Work Log

