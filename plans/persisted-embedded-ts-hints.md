---
status: draft
created: 2026-05-23
---
# Plan: Persisted Embedded-Timestamp Hints (Deferred)

**Created:** 2026-05-23 | **Status:** Deferred | **Effort:** S | **Depends on:** `plans/direct-fetch-fast-path.md` (must ship first)

## Why This Is Deferred

The Direct-Fetch Fast Path plan already eliminates the catastrophic CDX-timeout failure mode for HTML-discovered assets. This plan is a **second-order optimization** that helps a specific scenario: shared assets across multiple pages of the same archived site (e.g. navigation sprites, common CSS, framework JS), where:

1. User loads `/web/<ts>/site.com/page1.html`. Prewarm primes cache for 20 assets, including `/sprite.gif`. All cached.
2. User navigates to `/web/<ts>/site.com/page2.html`. HTML parse rediscovers `/sprite.gif` with the same embedded TS. Prewarm fires again for the same asset.

This is **wasted upstream bandwidth**, not a correctness or latency issue — the user-facing path still works fine. The fast path is doing more work than necessary; nothing is broken.

**Trigger to un-defer:** monitor `[direct] resolved-fetch` log volume in production. If a single hour shows >30% duplicate `(url, embeddedTs)` pairs across log entries, the optimization pays for itself.

## Problem Statement

After the Direct-Fetch Fast Path lands, every HTML/CSS response triggers prewarm for all embedded-TS asset URLs it contains. Wayback's HTML rewriter embeds the same resolved TS for an asset across every page that references it (Wayback's snapshot-resolution is per-asset, not per-page). The current design re-discovers and re-fetches that asset on each parent-page load.

If we persisted the `(originalUrl) → embeddedTs` mapping, subsequent page loads could:
- Skip prewarm entirely for already-known assets (cache HIT short-circuits this anyway).
- Skip Tier 2's redirect dance when an asset is requested without HTML context (e.g. user pastes a direct asset URL, or shares a bookmark to an asset).

## Proposed Approach

A per-asset sidecar inside the cache root: `<cacheRoot>/.hints/<sha256-of-originalUrl>` containing `{ embeddedTs: string, observedAt: number }` as JSON. Written by prewarm and by Tier 2 success. Read by `ProxyService` before deciding Tier 1 vs Tier 2.

### Schema

```
<cacheRoot>/.hints/<sha256-16-of-originalUrl>
  → JSON: { "embeddedTs": "20010912093045", "observedAt": 1779495887922 }
```

- Key: SHA-256 of the original URL (host + path + query), truncated to 16 hex chars. Matches the existing `sentinelPath` keying in `cache.ts:113-117` — collision risk negligible (~10^-19 per pair at typical scales).
- Value: small JSON blob. Atomic write (tmp + rename).
- TTL: implicit via `observedAt`. Default `HINT_TTL_DAYS=180` (assets re-indexed by Wayback occasionally — a stale hint pointing at a now-404 TS would force the proxy back to Tier 2, which is fine).

### Lookup flow change

`ProxyService.fetch` on cache MISS:
1. **NEW:** Read hint sidecar. If present and not expired → call `directClient.fetchAtResolvedTime(url, hint.embeddedTs)` (Tier 1 *without* needing prewarm to have run for this URL).
2. On Tier 1 `not_found` from hint → delete hint (it's stale), fall through to Tier 2.
3. On Tier 1 `ok` → write cache, done.
4. On Tier 1 `fallback` (5xx) → Tier 2.
5. On Tier 2 `ok` → write cache AND write hint with `resolvedTime` from the redirect.

### Prewarm flow change

Before fetching an asset in `prewarmAssets`:
1. Check if hint exists. If present with the same `embeddedTs` we'd write → skip (no work needed).
2. If absent or different `embeddedTs` → fetch and write hint after success.

## Steps

### Step 1: `CacheService.readHint` / `writeHint`

- **Test:** `tests/services/cache.test.ts` —
  - `writeHint(url, embeddedTs)` round-trips: `readHint(url)` returns `{ embeddedTs, observedAt }`.
  - `readHint` on a non-existent URL returns null.
  - `readHint` on an expired hint (`observedAt` older than TTL) returns null and deletes the file.
  - Atomic write: a malformed JSON file (simulated mid-write) makes `readHint` return null and clean up.
  - Path-traversal: same `computeAbsPath`-style guard applies to the hint path.

- **Implement:** `src/services/cache.ts` — add two methods, both following the existing sentinel path-construction pattern:
  ```ts
  async readHint(url: string): Promise<{ embeddedTs: string; observedAt: number } | null>;
  async writeHint(url: string, embeddedTs: string): Promise<void>;
  ```
  Reuse the existing `sentinelPath` keying convention (sha256-truncated) but under `<cacheRoot>/.hints/` instead of `<root>/.notfound/`.

- **Validation:** `pnpm test cache.test.ts`

### Step 2: Wire hint read/write into `ProxyService`

- **Test:** `tests/services/proxy.test.ts` —
  - Cache MISS with hint present → calls `fetchAtResolvedTime` with the hint's TS; does NOT call `fetchAtRequestedTime`.
  - Cache MISS with hint present + Tier 1 `not_found` → hint deleted, Tier 2 called.
  - Cache MISS without hint → Tier 2 called as today.
  - Tier 2 success → `writeHint` called with the resolved TS parsed from the redirect.
  - Prewarm hits an asset with matching hint → skips the upstream fetch (assert directClient NOT called).

- **Implement:** `src/services/proxy.ts` — add the lookup at the start of the MISS path; add the writes at Tier 1 / Tier 2 success.

- **Validation:** `pnpm test proxy.test.ts && pnpm typecheck`

### Step 3: Config knob + cleanup CLI

- **Test:** `tests/models/config.test.ts` — `HINT_TTL_DAYS` parses with default 180, range 1–3650.

- **Implement:**
  - `src/models/config.ts` — add `HINT_TTL_DAYS`.
  - `src/services/cache.ts` — `handleCacheClear` learns a new `?hints=1` query param to wipe just the `.hints/` directories without touching cached bytes. Useful when Wayback re-indexes and we want to force re-resolution.

- **Validation:** `pnpm test config.test.ts && pnpm test cache.test.ts`

## Acceptance Criteria

- [ ] After loading `/web/<ts>/site/page1.html` (prewarms 20 assets), loading `/web/<ts>/site/page2.html` does not re-fetch any of the 20 shared assets — verified by counting `[direct] resolved-fetch` log lines.
- [ ] Forcing a hint to expired-mtime causes the next request to delete it and fall through to Tier 2.
- [ ] `?hints=1` cache-clear wipes only hint files; cached asset bytes remain.
- [ ] `pnpm test` and `pnpm typecheck` both green.

## Out of Scope (Deferred from This Deferred Plan)

- Sharing hints across replicas (Redis-backed hint store). Same logic as the parent plan — single-replica deployment makes filesystem hints sufficient.
- Time-bucket hint variants (multiple `embeddedTs` for the same URL across different requested times). Not needed: Wayback's per-asset resolution is a function of the asset, not the requested page time.

## Triggering Condition Recap

Do not implement this plan until:
- The Direct-Fetch Fast Path plan is shipped and stable in production.
- Production logs show measurable duplicate prewarm work (>30% duplicate `(url, embeddedTs)` pairs over a representative time window) OR a user-facing complaint about asset bandwidth.
