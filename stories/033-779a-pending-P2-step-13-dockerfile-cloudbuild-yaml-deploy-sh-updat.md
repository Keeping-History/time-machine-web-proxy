---
id: "033-779a"
title: "Step 13: Dockerfile + cloudbuild.yaml + deploy.sh updates"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:53.718Z
updated: 2026-05-20T03:19:53.718Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 13"
---

# Step 13: Dockerfile + cloudbuild.yaml + deploy.sh updates

## Problem Statement

Update build infrastructure to use pnpm and Corepack instead of npm

## Acceptance Criteria

- [ ] Dockerfile: replace npm install with Corepack pattern (npm install -g corepack@latest && corepack enable && corepack prepare pnpm@<ver> --activate) with ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
- [ ] Dockerfile: replace COPY timemachine.ts with COPY src/ ./src/ and add COPY pnpm-lock.yaml
- [ ] cloudbuild.yaml: replace npm run build with pnpm run build
- [ ] deploy.sh: replace npm references with pnpm
- [ ] docker build . succeeds locally

## Work Log

