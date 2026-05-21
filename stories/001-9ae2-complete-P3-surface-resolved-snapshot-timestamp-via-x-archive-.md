---
id: 001-9ae2
title: Surface resolved snapshot timestamp via X-Archive-Time
status: complete
priority: P3
type: feature
created: "2026-05-21T22:55:23.748Z"
updated: "2026-05-21T23:01:01.298Z"
dependencies: []
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 4-follow-on
started_at: "2026-05-21T22:55:28.171Z"
completed_at: "2026-05-21T23:01:01.297Z"
---

# Surface resolved snapshot timestamp via X-Archive-Time

## Problem Statement

Worker resolves the requested time to a different actual snapshot (e.g. 20010912 → 20010822231227). Currently ProxyService returns archiveTime = requested time, so clients have no way to know which snapshot they actually got. Honor the on-or-before semantic by writing a sidecar with the resolved time and surfacing it via X-Archive-Time.

## Acceptance Criteria

- [x] CacheService.writeResolvedTimeSidecar(time, url, resolvedTime) writes <root>/<bareHost>/.resolved-time containing the 14-digit resolved timestamp
- [x] CacheService.lookup returns CacheHit with optional archiveTime field, read from the sidecar when present
- [x] Worker calls writeResolvedTimeSidecar after successful download_files
- [x] ProxyService.fetch returns archiveTime = hit.archiveTime ?? requestedTime so X-Archive-Time reflects the actual snapshot
- [x] Cache HIT for legacy files without sidecar still works
- [x] npm test passes

## QA

None — verified end-to-end against Docker container

## Work Log

### 2026-05-21T23:00:59.916Z - Added CacheService.writeResolvedTimeSidecar(time, url, resolvedTime) writing <root>/.resolved-time as a 14-digit string. Extended CacheHit with optional archiveTime; lookup reads sidecar via readResolvedTime helper (returns undefined for legacy files without sidecar). Worker calls sidecar write after successful download_files for both exact and crawl. ProxyService returns hit.archiveTime ?? requestedTime. Verified end-to-end: curl 'http://www.apple.com&time=20010913000000' returns X-Archive-Time: 20010822231227.

