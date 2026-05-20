---
id: "023-1e64"
title: "Step 3: src/lib/config.ts — loadConfig and ensureCacheDir"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:03.353Z
updated: 2026-05-20T03:19:03.353Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 3"
---

# Step 3: src/lib/config.ts — loadConfig and ensureCacheDir

## Problem Statement

Extract all process.env reads into a pure loadConfig() function, split filesystem side-effect into ensureCacheDir()

## Acceptance Criteria

- [ ] Create src/lib/config.ts with loadConfig(): Config (pure — no side effects)
- [ ] Create ensureCacheDir(cacheDir: string): void as separate export
- [ ] loadConfig() consolidates WS_KEEPALIVE_MS (currently read late at line 963)
- [ ] Write tests/lib/config.test.ts: defaults when env vars absent, correct types when set, TypeError thrown on malformed PROXY_BASE_URL
- [ ] Tests require zero filesystem mocks (pure function)
- [ ] pnpm run typecheck passes

## Work Log

