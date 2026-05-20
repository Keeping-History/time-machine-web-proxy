---
id: 023-1e64
title: "Step 3: src/lib/config.ts — loadConfig and ensureCacheDir"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:03.353Z"
updated: "2026-05-20T14:29:25.800Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 3
started_at: "2026-05-20T14:27:40.400Z"
completed_at: "2026-05-20T14:29:25.799Z"
---

# Step 3: src/lib/config.ts — loadConfig and ensureCacheDir

## Problem Statement

Extract all process.env reads into a pure loadConfig() function, split filesystem side-effect into ensureCacheDir()

## Acceptance Criteria

- [x] Create src/lib/config.ts with loadConfig(): Config
- [x] Create ensureCacheDir(cacheDir: string): void as separate export
- [x] loadConfig() consolidates WS_KEEPALIVE_MS
- [x] Write tests/lib/config.test.ts: defaults when env vars absent, correct types when set, TypeError thrown on malformed PROXY_BASE_URL
- [x] Tests require zero filesystem mocks
- [x] pnpm run typecheck passes

## QA

None

## Work Log

### 2026-05-20T14:29:24.628Z - Completed: loadConfig() pure fn + ensureCacheDir() separated. 6 tests. Fixed toThrow(TypeError) Jest 30 quirk → toThrow(/Invalid URL/).

