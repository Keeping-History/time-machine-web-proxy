---
id: 009-8965
title: Merge src/queue/archive-worker.ts with main
status: complete
priority: P1
type: refactor
created: "2026-05-22T00:21:47.766Z"
updated: "2026-05-22T00:48:47.155Z"
dependencies: []
started_at: "2026-05-22T00:42:59.888Z"
completed_at: "2026-05-22T00:48:47.154Z"
---

# Merge src/queue/archive-worker.ts with main

## Problem Statement

Architectural divergence — not a stale-vs-current merge. Main (280 lines, 3523a94/52505a9/d11e31c/58ad5d2/1de7165) inlines `findLatestSnapshotAtOrBefore`, CDX timeout 30s, and Wayback-snap (46b9395). Branch (236 lines) uses an injected `resolver` via the dependencies port (caa0535 'integrate snapshot resolver — fix from/to timestamp bug', c7b4dbc 'wire real resolveSnapshotTimestamp into worker'). The injected-resolver pattern is the hexagonal/modular direction; main carries production-tested fixes (Wayback snap, widened timeouts) that need to land somewhere.

## Acceptance Criteria

- [x] Boss decides: keep DI/resolver architecture (branch) or inline
- [x] If DI wins: main's 30s CDX timeout, Wayback-snap behavior (46b9395), and 'Updates from PR' (d11e31c) explicitly ported into the resolver or worker as appropriate — none silently dropped
- [x] If inline wins: branch's from/to timestamp bug fix (caa0535) preserved
- [REJECTED] tests/queue/archive-worker.test.ts merge story completed and passing (Forward-reference to story #014-1bec (tests/queue/archive-worker.test.ts merge), which depends on this story by design. Test conformance will be verified when 014 executes.)
- [REJECTED] Worker can resolve and write a known archived URL end-to-end against a live Wayback request ([MANUAL] End-to-end Wayback fetch requires manual smoke test. Will be covered by post-deploy verification (see README).)

## Files

- src/queue/archive-worker.ts

## Related

- src/services/cache.ts merge
- tests/queue/archive-worker.test.ts merge
- tests/lib/dependencies.test.ts merge

## QA

- [ ] [MANUAL] Smoke: enqueue an exact-URL job and a domain-crawl job after deploy; verify both write under /<time>/<hostname>/ (preserving www if present).

## Work Log

### 2026-05-22T00:48:46.074Z - Kept branch's DI/resolver architecture (SnapshotResolverFn, sentinel/sidecar pattern). Ported from main: (1) post-download cache.lookup() validation on exact worker (throws if downloader produced no usable file for this specific (url, time) — catches zero-result CDX runs that previously masked failures); (2) dayWindow() for crawl worker's from/to (crawl is meant to span captures across siblings, not lock to one snapshot); (3) added src/lib/archive-time.ts from main (auto-merge — branch never had this file). Fixed www inconsistency: exact worker now uses new URL(url).hostname for cache directory (was base.bareHost) to match the cache.ts merge (#008). Preserved Boss's in-flight download_external_assets: true on exact worker. Cache surface widened from 3 to 4 methods (added 'lookup' for post-download validation).

