---
id: 002-d955
title: "feat(cache): add readHint/writeHint with sliding TTL and LRU layer"
status: blocked
priority: P3
type: feature
created: "2026-05-23T18:36:08.564Z"
updated: "2026-05-23T18:36:54.874Z"
dependencies: []
plan: plans/persisted-embedded-ts-hints.md
plan_step: Step 1
---

# feat(cache): add readHint/writeHint with sliding TTL and LRU layer

## Problem Statement

After the Direct-Fetch Fast Path ships, every HTML/CSS page load triggers prewarm for embedded-TS assets — but with no persistence of the (url, embeddedTs) mapping, the same shared assets across multiple pages of an archived site re-fetch the same Wayback snapshot every page load. Persisting a per-asset filesystem sidecar with the embedded TS lets later requests short-circuit Tier 2 redirect dances. This story adds the CacheService primitives only; ProxyService wiring is Story 2.

## Acceptance Criteria

- [ ] writeHint(url, embeddedTs) round-trips via readHint(url) -> {embeddedTs, observedAt}
- [ ] readHint returns null for a non-existent URL
- [ ] readHint on expired hint (observedAt older than hintTtlDays) returns null AND unlinks the file
- [ ] Atomic write: writeHint writes <dest>.tmp first, then renames to <dest>
- [ ] Path-traversal payloads (e.g. %2e%2e%2f) reject with status: 400
- [ ] Hint file lives at <cacheDir>/v2-hints/<host>/<sha-16> (NOT <cacheRoot>/.hints/<sha-16>)
- [ ] Hash key omits protocol: http:// and https:// for the same (host, path, query) produce the SAME hint path
- [ ] Hash key preserves host: www.example.com and example.com produce DIFFERENT hint paths
- [ ] cacheEnabled=false: readHint returns null without touching fs (no fs.readFile call)
- [ ] Corruption recovery: malformed JSON makes readHint return null + WARN log; fs.unlink is NOT called; file remains on disk
- [ ] Next writeHint after corruption cleanly overwrites via atomic rename
- [ ] LRU layer populates on first disk read; second readHint within hintTtlDays does NOT call fs.readFile
- [ ] LRU negative caching: first readHint on missing URL hits fs once; second readHint within 60s does NOT
- [ ] writeHint invalidates the LRU entry for that key
- [ ] Sliding TTL: re-writing the same URL refreshes observedAt to Date.now()

## Work Log

### 2026-05-23T18:36:54.747Z - Blocked pending the un-defer trigger: (1) direct-fetch-fast-path plan must ship and stabilize in production, (2) production logs must show >30% duplicate (url, embeddedTs) pairs per hour across [direct] resolved-fetch events OR a user-facing complaint about asset bandwidth. Re-evaluate before unblocking.

