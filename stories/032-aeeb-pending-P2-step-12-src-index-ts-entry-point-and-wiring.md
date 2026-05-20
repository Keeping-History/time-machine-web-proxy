---
id: "032-aeeb"
title: "Step 12: src/index.ts — entry point and wiring"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:53.476Z
updated: 2026-05-20T03:19:53.476Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 12"
---

# Step 12: src/index.ts — entry point and wiring

## Problem Statement

Create the entry point that wires all injected classes together and replaces timemachine.ts as the build entry

## Acceptance Criteria

- [ ] Create src/index.ts wiring: loadConfig, ensureCacheDir, ShutdownController, ArchiveRequestQueue, WaybackClient, CacheService, ProxyService, TimeMachineService
- [ ] Update package.json build script entry point from timemachine.ts to src/index.ts
- [ ] Remove timemachine.ts from tsconfig.json include (keep only src/**/* and tests/**/*)
- [ ] pnpm run build produces dist/timemachine.js
- [ ] node dist/timemachine.js starts and serves requests identically to original

## Work Log

