---
id: "002-ebcd"
title: "Add wayback-machine-downloader deps and type declaration"
status: pending
priority: P2
type: chore
created: 2026-05-20T17:11:01.866Z
updated: 2026-05-20T17:11:01.866Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 1"
---

# Add wayback-machine-downloader deps and type declaration

## Problem Statement

The wayback-machine-downloader npm package has no TypeScript types. BullMQ and ioredis also need to be installed.

## Acceptance Criteria

- [ ] pnpm add installs wayback-machine-downloader@0.5.0 tarball, bullmq, ioredis
- [ ] src/types/wayback-machine-downloader.d.ts created with corrected normalizeBaseUrlInput return type (bareHost/unicodeHost/variants, not host)
- [ ] tests/types/wayback-machine-downloader.test-d.ts type-only test passes
- [ ] pnpm typecheck passes clean

## Work Log

