---
id: "035-abfd"
title: "Configure Node.js and pnpm versions with mise"
status: pending
priority: P2
type: chore
created: 2026-05-20T15:05:54.309Z
updated: 2026-05-20T15:05:54.309Z
dependencies: []
---

# Configure Node.js and pnpm versions with mise

## Problem Statement

Project currently has no toolchain version pinning; developers may use different Node.js or pnpm versions, causing inconsistent behavior. mise (formerly rtx) provides a .mise.toml or .tool-versions file to pin the runtime versions used by this project.

## Acceptance Criteria

- [ ] Add .mise.toml (or .tool-versions) to repo root pinning Node.js 22.x and pnpm matching package.json engines field
- [ ] mise install works from a clean checkout
- [ ] node --version and pnpm --version match the pinned versions after mise activate

## Work Log

