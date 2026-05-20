---
id: 032-aeeb
title: "Step 12: src/index.ts — entry point and wiring"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:53.476Z"
updated: "2026-05-20T15:11:38.166Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 12
started_at: "2026-05-20T15:08:20.195Z"
completed_at: "2026-05-20T15:11:38.165Z"
---

# Step 12: src/index.ts — entry point and wiring

## Problem Statement

Create the entry point that wires all injected classes together and replaces timemachine.ts as the build entry

## Acceptance Criteria

- [x] Create src/index.ts wiring: loadConfig, ensureCacheDir, ShutdownController, ArchiveRequestQueue, WaybackClient, CacheService, ProxyService, TimeMachineService
- [x] Update package.json build script entry point from timemachine.ts to src/index.ts
- [x] Remove timemachine.ts from tsconfig.json include
- [x] pnpm run build produces dist/timemachine.js
- [x] node dist/timemachine.js starts and serves requests identically to original

## QA

None

## Work Log

### 2026-05-20T15:11:16.509Z - Created src/index.ts wiring all classes; updated package.json build to src/index.ts with --format=cjs + dist/package.json; removed timemachine.ts from tsconfig include; build produces dist/timemachine.js; server starts and serves requests (verified HTTP 200)

