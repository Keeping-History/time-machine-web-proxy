---
id: 006-e759
title: Merge src/models/config.ts with main
status: complete
priority: P1
type: refactor
created: "2026-05-22T00:21:47.765Z"
updated: "2026-05-22T00:36:56.513Z"
dependencies: ["005-d125"]
started_at: "2026-05-22T00:36:20.504Z"
completed_at: "2026-05-22T00:36:56.512Z"
---

# Merge src/models/config.ts with main

## Problem Statement

Models file for the config layer — paired with src/lib/config.ts. Branch added types for SNAPSHOT_WINDOW_DAYS / ALLOW_LATER_FALLBACK (d6f9d78). Main has parallel proxy/deployment updates (58ad5d2, 6297960). Type shape must stay in sync with the merged config.ts.

## Acceptance Criteria

- [x] Diff of branch:src/models/config.ts vs origin/main:src/models/config.ts reviewed with Boss
- [x] Final config model matches the surviving env keys from the config.ts merge exactly
- [x] No `any` types introduced; no unused exports left behind
- [x] Type-check passes

## Files

- src/models/config.ts

## Related

- src/lib/config.ts merge

## QA

None — covered by tsc --noEmit on src/

## Work Log

### 2026-05-22T00:36:21.338Z - models/config.ts merged in lockstep with src/lib/config.ts (#005-d125): added outboundProxyUrls[], outboundProxyChooser, outboundProxyCooldownMs + OutboundProxyChooser type from main; preserved branch's snapshotWindowDays[] + allowLaterFallback; dropped singular outboundProxyUrl. src/ typechecks cleanly.

