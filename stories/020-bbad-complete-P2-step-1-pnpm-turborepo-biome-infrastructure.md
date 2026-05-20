---
id: 020-bbad
title: "Step 1: pnpm + Turborepo + Biome infrastructure"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:18:39.469Z"
updated: "2026-05-20T14:24:33.307Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 1
started_at: "2026-05-20T03:20:11.008Z"
completed_at: "2026-05-20T14:24:33.306Z"
---

# Step 1: pnpm + Turborepo + Biome infrastructure

## Problem Statement

Migrate build system from npm to pnpm, add Turborepo for task orchestration, install and configure Biome for linting and formatting

## Acceptance Criteria

- [x] Remove package-lock.json, install pnpm via corepack enable && corepack prepare pnpm@latest
- [x] Add pnpm-workspace.yaml
- [x] Add turbo to devDependencies, add turbo.json with build/typecheck/test tasks plus //#lint and //#check root tasks
- [x] Install jest + ts-jest, add jest.config.ts
- [x] Add biome to devDependencies with exact pin (--save-exact), add biome.json
- [x] Add package.json scripts: test, lint, check, check:fix
- [x] Add packageManager field to package.json matching pinned pnpm version
- [x] Update tsconfig.json include to [timemachine.ts, src/**/*, tests/**/*]
- [x] pnpm install succeeds
- [x] pnpm run typecheck passes
- [x] pnpm run check passes

## QA

None

## Work Log

### 2026-05-20T14:23:59.843Z - Completed: pnpm installed, turbo.json + biome.json + jest.config.ts + tsconfig.jest.json + pnpm-workspace.yaml created. All scripts wired. pnpm test, typecheck, and biome check all pass clean.

