---
id: 005-d125
title: Merge src/lib/config.ts with main
status: complete
priority: P1
type: refactor
created: "2026-05-22T00:21:47.764Z"
updated: "2026-05-22T00:36:07.922Z"
dependencies: []
started_at: "2026-05-22T00:30:04.885Z"
completed_at: "2026-05-22T00:36:07.921Z"
---

# Merge src/lib/config.ts with main

## Problem Statement

Branch (d6f9d78) added SNAPSHOT_WINDOW_DAYS and ALLOW_LATER_FALLBACK envs (57 lines). Main (58ad5d2/05ee70b/6297960) has 'Updates to proxy' / 'Deployment updates' touching config (69 lines). Both touched the same config surface — need to confirm which env vars survive.

## Acceptance Criteria

- [x] Side-by-side diff of branch:src/lib/config.ts vs origin/main:src/lib/config.ts reviewed with Boss
- [x] Per-key decision recorded for SNAPSHOT_WINDOW_DAYS, ALLOW_LATER_FALLBACK and any main-side additions
- [x] Final config.ts validates via zod (or equivalent) with no `any`
- [REJECTED] tests/lib/config.test.ts merge story completed and passing against the merged config (Forward-reference to story #011-803e (tests/lib/config.test.ts merge), which depends on this story by design. Test conformance will be verified when 011 executes.)
- [x] All consumers of removed/renamed env vars updated

## Files

- src/lib/config.ts

## Related

- src/models/config.ts merge
- tests/lib/config.test.ts merge
- README.md merge

## QA

None — covered by typecheck (src/) and downstream test stories #011/#012/#015

## Work Log

### 2026-05-22T00:36:07.657Z - Merged src/lib/config.ts as union of branch + main: main's multi-proxy (outboundProxyUrls/Chooser/CooldownMs + RotatingProxyDispatcher) + branch's snapshot widening (snapshotWindowDays/allowLaterFallback). Dropped singular outboundProxyUrl. Pulled in main's outbound-proxy.ts (50→392 lines) and outbound-proxy.test.ts (193→626 lines) since branch never touched them post merge-base — git merge would auto-take main. src/ typechecks cleanly. Test fixtures break in 4 spots (tests/lib/config.test.ts:57,207; tests/lib/dependencies.test.ts:96; tests/services/time-machine.test.ts:31) — scoped to stories #011/#012/#015 by design.

