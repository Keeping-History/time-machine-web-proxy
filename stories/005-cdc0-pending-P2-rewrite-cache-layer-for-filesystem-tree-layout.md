---
id: "005-cdc0"
title: "Rewrite cache layer for filesystem-tree layout"
status: pending
priority: P2
type: feature
created: 2026-05-20T17:11:02.059Z
updated: 2026-05-20T17:11:02.059Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 4"
---

# Rewrite cache layer for filesystem-tree layout

## Problem Statement

Current SHA256+JSON cache format is incompatible with wayback-machine-downloader output. New v2 layout mirrors the downloader native tree: cacheDir/v2/time/host/path.

## Acceptance Criteria

- [ ] src/services/cache.ts rewritten: CacheHit type, cacheDirForJob, lookup using fs.access
- [ ] Path traversal protection: lookup throws 400 for traversal attempts
- [ ] cache.lookup returns null for absent files, CacheHit for present files with correct content-type from mime-types
- [ ] handleCacheClear operates only under cacheDir/v2/
- [ ] tests/services/cache.test.ts passes all scenarios including path traversal

## Work Log

