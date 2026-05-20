---
id: 035-abfd
title: Configure Node.js and pnpm versions with mise
status: complete
priority: P2
type: chore
created: "2026-05-20T15:05:54.309Z"
updated: "2026-05-20T15:17:25.749Z"
dependencies: []
started_at: "2026-05-20T15:16:36.854Z"
completed_at: "2026-05-20T15:17:25.749Z"
---

# Configure Node.js and pnpm versions with mise

## Problem Statement

Project currently has no toolchain version pinning; developers may use different Node.js or pnpm versions, causing inconsistent behavior. mise (formerly rtx) provides a .mise.toml or .tool-versions file to pin the runtime versions used by this project.

## Acceptance Criteria

- [x] Add .mise.toml (or .tool-versions) to repo root pinning Node.js 22.x and pnpm matching package.json engines field
- [x] mise install works from a clean checkout
- [x] node --version and pnpm --version match the pinned versions after mise activate

## QA

None

## Work Log

### 2026-05-20T15:17:22.351Z - Added .mise.toml pinning node=22 (resolves to 22.22.3) and pnpm=10.26.0; mise install succeeds; mise exec confirms correct versions

