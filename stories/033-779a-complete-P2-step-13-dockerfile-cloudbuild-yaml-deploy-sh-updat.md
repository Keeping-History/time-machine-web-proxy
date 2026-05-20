---
id: 033-779a
title: "Step 13: Dockerfile + cloudbuild.yaml + deploy.sh updates"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:53.718Z"
updated: "2026-05-20T15:13:55.886Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 13
started_at: "2026-05-20T15:11:46.805Z"
completed_at: "2026-05-20T15:13:55.885Z"
---

# Step 13: Dockerfile + cloudbuild.yaml + deploy.sh updates

## Problem Statement

Update build infrastructure to use pnpm and Corepack instead of npm

## Acceptance Criteria

- [x] Dockerfile: replace npm install with Corepack pattern (npm install -g corepack@latest && corepack enable && corepack prepare pnpm@<ver> --activate) with ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
- [x] Dockerfile: replace COPY timemachine.ts with COPY src/ ./src/ and add COPY pnpm-lock.yaml
- [x] cloudbuild.yaml: replace npm run build with pnpm run build
- [x] deploy.sh: replace npm references with pnpm
- [x] docker build . succeeds locally

## QA

None

## Work Log

### 2026-05-20T15:13:51.844Z - Updated Dockerfile: Corepack pnpm install, COPY src/ and pnpm-lock.yaml, pnpm run build; added .dockerignore; no npm refs in cloudbuild.yaml or deploy.sh; docker build succeeds

