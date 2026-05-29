---
status: approved
created: 2026-05-23
approved_at: "2026-05-23T18:36:08.585Z"
updated: "2026-05-23T18:36:08.585Z"
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

### Research Enhancement

- **Path scheme correction (supersedes the schema above):** `<cacheDir>/v2-hints/<host>/<sha-16>`, NOT `<cacheRoot>/.hints/<sha-16>`. The existing `buildPerUrlSubpath` nests per-URL sidecars under `<cacheRoot>/v2/<time>/<host>/<subdir>/<sha-16>` (`cache.ts:268-279`), which is time-scoped and so cannot back a hint that must outlive a specific page-time request. A sibling `v2-hints/` root is the correct shape: walkable by host (so `?domain=*.example.com` can prune hints without sha-decoding), survives `?domain=` clears via an additional walk, and is a single `fs.rm` target for full clears. There is no existing precedent for a global per-URL sidecar — this introduces a new layout pattern alongside `v2/` and follows the same v1→v2 clean-cutover precedent (commits `5abc398`, `e18006b`): no migration, the new dir starts empty and fills naturally.
- **Hash key correction:** drop the protocol from the hash. Use `${u.host}${u.pathname}${u.search}` (NOT `${u.protocol}//${u.host}${u.pathname}${u.search}` from `buildPerUrlSubpath`). Wayback serves the same asset bytes regardless of whether the original reference was `http://` or `https://`; protocol-inclusive keying would double the hint set with no benefit. Keep `www.example.com` ≠ `example.com` (matches the `lookup` policy at `cache.ts:78-79` and its locked-in test at `cache.test.ts:222-230`).
- **TTL refresh policy (sliding TTL):** on prewarm re-observation of a matching `embeddedTs`, REWRITE the JSON with an updated `observedAt`. Sliding TTL keeps in-use hints alive indefinitely; hard-TTL-from-first-observation silently expires actively-used hints on day 180. Idempotent via tmp+rename. Write amplification estimate for a typical archived site (50 shared assets × 20 pages × 10 visits/day = 10k prewarms/day): ~10k small JSON writes/day, all fire-and-forget, ~zero once cache is warm because prewarm short-circuits on HIT.
- **Embedded-TS-stability assumption is untested.** The plan's claim that Wayback's per-asset resolution is independent of requested page-time has no historical support in the repo (no commit, comment, or test asserts it; the wave-1 commit `d9b2494` introduces the concept without justification). Add an opt-in sampling verifier: `HINT_VERIFY_SAMPLE_RATE` (float 0–1, default `0.01`). On Tier 1 hit via hint, when `Math.random() < sampleRate`, fire a background `fetchAtRequestedTime` and compare the resolved time. If different, log `[cache] hint-drift-detected` at `warn` with `{ url, hintTs, freshTs }` and overwrite. Purely observability — never blocks the response.
- **Kill switch:** `HINTS_ENABLED` (bool, default `true`) so production can disable independently of the parent fast path.
- **Ref:** repo-research-researcher, best-practices-researcher (GCS FUSE perf, Redis sliding-TTL pattern), git-history-researcher (cache layout v1→v2 precedent, opportunistic-sidecar precedent in commit `ad996a6`).

### Lookup flow change

`ProxyService.fetch` on cache MISS:
1. **NEW:** Read hint sidecar. If present and not expired → call `directClient.fetchAtResolvedTime(url, hint.embeddedTs)` (Tier 1 *without* needing prewarm to have run for this URL).
2. On Tier 1 `not_found` from hint → delete hint (it's stale), fall through to Tier 2.
3. On Tier 1 `ok` → write cache, done.
4. On Tier 1 `fallback` (5xx) → Tier 2.
5. On Tier 2 `ok` → write cache AND write hint with `resolvedTime` from the redirect.

### Research Enhancement

- **Sentinel order of operations:** the existing `cache.lookup` short-circuits with a `404` when a `.notfound` sentinel exists (`cache.ts:138-155`). Hint reads must happen AFTER `lookup`, never instead of it — a fresh sentinel within `notFoundTtlDays` must beat a stale hint. Concretely: on MISS, the flow stays `lookup → (404 throw on sentinel) → readHint → Tier 1 (if hint) → Tier 2 → Tier 3`. A test pairing "stale hint + active sentinel" must assert the 404 path wins.
- **Tier 1 outcome handling (preserve vs delete):**
  - `ok` → keep hint, refresh `observedAt` (sliding TTL), write cache.
  - `not_found` → delete hint (it's stale), fall through to Tier 2.
  - `fallback` (5xx, timeout, unexpected 3xx) → PRESERVE hint (a transient blip doesn't invalidate the embedded TS), fall through to Tier 2.
- **Tier 2 `resolvedTime=undefined` is structurally safe:** `fetchAtRequestedTime` returns `resolvedTime?: string` (`wayback-direct-client.ts:188`, RESOLVED_TIME_RE non-match yields undefined). The existing proxy.ts:75-77 already guards with `if (direct.resolvedTime)`. Place `writeHint` inside that same block — no new guard needed, undefined falls through silently. Adopting the requested `time` as a fallback would propagate misinformation and is rejected.
- **Insertion site:** `proxy.ts:75-77` (inside the `direct.outcome === "ok"` branch). New order: `writeFile → writeResolvedTimeSidecar → writeHint → writeContentTypeSidecar → re-lookup`. Hint after the resolved-time sidecar so the two reads see consistent state on crash recovery.
- **In-memory LRU layer (GCS FUSE mitigation):** every MISS does an extra `fs.readFile` on the hint path, which on GCS-FUSE is a 50–150 ms metadata round trip. Add an in-process `lru-cache` (~5,000 entries, ~2–3 MB RSS) keyed by the same canonical string used for the sha. TTL on LRU entries = `HINT_TTL_DAYS * 86_400_000`. Populate on disk read; invalidate on `writeHint`/delete. Also cache negative results (no-hint) for 60 s so a page-load burst of new URLs doesn't pay 100× ENOENT round trips.
- **Performance budget:** worst-case prewarm of 100 assets on a cold page = up to 100 additional FUSE writes serially, each ~100–300 ms = 10–30 s of fire-and-forget background work. Acceptable because the user response is already sent; but the work overlaps the next page load if visits are rapid. The LRU absorbs the read cost, and the `HINTS_ENABLED` kill switch lets production disable if the cost exceeds the savings.
- **Ref:** best-practices-researcher (GCS FUSE perf, lru-cache pattern), repo-research-researcher (insertion-site line numbers).

### Prewarm flow change

Before fetching an asset in `prewarmAssets`:
1. Check if hint exists. If present with the same `embeddedTs` we'd write → skip (no work needed).
2. If absent or different `embeddedTs` → fetch and write hint after success.

### Research Enhancement

- **Skip implies refresh:** when the existing hint matches the incoming `embeddedTs`, refresh `observedAt` (sliding TTL — see Schema enhancement). "Skip" means "skip the upstream fetch", not "skip the hint touch". Without this, an asset hinted on day 1 and re-prewarmed daily expires on day 180 even though it has been continuously useful.
- **Drift policy on `embeddedTs` mismatch:** when the existing hint exists but with a DIFFERENT `embeddedTs`, the prewarm proceeds (fetches via the new TS, writes a fresh hint). Last-writer-wins, document this — Wayback re-indexing produces this case legitimately. Add a `[cache] hint-drift-prewarm` debug log so we can measure drift frequency.
- **Concurrent prewarm race for the same URL:** `DedupingDirectClient` (`deduping-direct-client.ts:65-105`) already collapses concurrent `fetchAtResolvedTime` calls keyed by `<namespace>:<url>:<ts>`. The remaining race is two concurrent calls with DIFFERENT `embeddedTs` for the same URL — both reach `writeHint` and race on the `.tmp` rename. POSIX `rename` is atomic; the resulting file contains one of the two values, never a half-write. Keep the existing fixed `.tmp` suffix (`TMP_SUFFIX = ".tmp"` at `cache.ts:13`) — the existing test `cache.test.ts:668-687` explicitly asserts this shape, diverging would create inconsistency without a safety gain.
- **Dedicated observability event for the trigger condition:** the un-defer trigger is ">30% duplicate `(url, embeddedTs)` pairs per hour". The current `[direct] resolved-fetch` log is at `debug` (`wayback-direct-client.ts:139`); Cloud Run typically retains `info+`, so the trigger query would have no data. Emit a NEW `info`-level event on the skip path:
  ```jsonc
  this.logger.info(
    { event: "prewarm_duplicate_skip", url, embeddedTs, hintAge: ageSec },
    "[prewarm] duplicate-skip"
  );
  ```
  Pair it with a counter at the resolved-fetch outcome to compute the ratio. Cloud Logging filter (per asset, info level):
  ```
  resource.type="cloud_run_revision"
    AND jsonPayload.event="prewarm_duplicate_skip"
  ```
  Promote to a log-based metric, then alert when `prewarm_duplicate_skip / (resolved_fetch + prewarm_duplicate_skip) > 0.30` over a 1-hour window. Do NOT sample duplicate-skip events — they ARE the signal.
- **Prewarm hint write timing:** inside the existing fire-and-forget block at `proxy.ts:131-150`, write the hint after `cache.writeFile` and `writeContentTypeSidecar`, and BEFORE returning from the `.then` callback. Keep the existing `.catch` so a hint-write failure logs at info level and never escapes.
- **Ref:** best-practices-researcher (observability fields + Cloud Logging filter), repo-research-researcher (DedupingDirectClient race analysis, fire-and-forget call site).

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

### Research Enhancement

- **Use `<cacheDir>/v2-hints/<host>/<sha-16>`, not `<cacheRoot>/.hints/<sha-16>`** (see Schema enhancement). Add a new private `buildHintPath(url): string` rooted at `<cacheDir>/v2-hints/` with the standard `startsWith(hintsRoot + sep)` traversal guard.
- **Hashing string:** `${u.host}${u.pathname}${u.search}` — protocol-agnostic, www/apex preserved (see Schema enhancement).
- **`cacheEnabled=false` gating:** `readHint` MUST gate at the top (`if (!this.config.cacheEnabled) return null`), matching `lookup`'s policy at `cache.ts:75`. `writeHint` does NOT need the gate — other writers (`writeFile`, `writeNotFoundSentinel`, `writeResolvedTimeSidecar`, `writeContentTypeSidecar`) do not gate, and the caller (`ProxyService`) only invokes them after a MISS, which with `cacheEnabled=false` only fires through the disabled `lookup`. Be consistent.
- **Corruption recovery (Option 2 — leave + log warn):** on `JSON.parse` failure, return `null` and `logger.warn`. Do NOT `unlink` — the next `writeHint` overwrites via atomic rename. Unlink-on-parse-fail creates a TOCTOU race against a concurrent writer that has just renamed a valid file into place. `.corrupt` quarantine has the same race AND accumulates orphan files on GCS. Test the recovery deterministically: pre-seed a corrupt file via direct `fs.writeFile`, call `readHint` → null + warn + file still present, then `writeHint` overwrites it cleanly.
- **`Pick<Config, ...>` constructor update:** widen `cache.ts:37` from `Pick<Config, "cacheDir" | "cacheEnabled" | "notFoundTtlDays">` to also include `"hintTtlDays"` and `"hintsEnabled"`. `proxy.ts:52-55` only needs `"hintsEnabled"` IF the proxy reads the kill switch directly (preferred — short-circuit reads/writes there to avoid useless CacheService calls).
- **In-memory LRU layer:** wire `lru-cache` (already a transitive dep — verify; add as direct dep if not) into `CacheService`. Keys: same canonical string `${u.host}${u.pathname}${u.search}`. Values: `{ embeddedTs, observedAt } | null` (the `null` sentinel = "no hint on disk"). Two TTLs: positive entries use `hintTtlDays * 86_400_000`, negative entries use `60_000` (60 s). Invalidate on `writeHint` and on stale-deletion in `readHint`.
- **Test skeleton additions (matching existing `cache.test.ts` style — `jest.mock("node:fs")`, no fake timers, factory at `makeService`):**
  - Add `hintTtlDays` and `hintsEnabled` params to `makeService(...)`.
  - `writeHint` writes under `<cacheDir>/v2-hints/<host>/<sha-16>` with `.tmp` then rename — assert the regex `^/tmp/cache/v2-hints/example\.com/[0-9a-f]{16}(\.tmp)?$`.
  - `http://` and `https://` for the same `(host, path, query)` produce the SAME hint path.
  - `www.example.com` and `example.com` produce DIFFERENT hint paths.
  - Round-trip: write then read returns `{ embeddedTs, observedAt }`.
  - Stale hint: payload with `observedAt = Date.now() - (hintTtlDays+1)*86_400_000` → `readHint` returns null AND unlinks (this IS the one case where unlink is correct — explicit TTL expiry, not corruption).
  - Malformed JSON: `readHint` returns null, `unlink` NOT called, file still present.
  - `cacheEnabled=false`: `readHint` returns null without `fs.readFile` ever being called.
  - Path-traversal `https://example.com/%2e%2e%2fetc%2fpasswd` rejects with `status: 400`.
  - Concurrent-write (sequential approximation via two `writeHint` calls): final file contents are deterministic (last write wins).
  - LRU population: a `readHint` for a URL hits disk once; a second `readHint` (within TTL) does NOT touch fs (assert `fs.readFile` call count).
  - LRU negative caching: first `readHint` on a non-existent URL hits disk; second `readHint` within 60 s does NOT.

### Step 2: Wire hint read/write into `ProxyService`

- **Test:** `tests/services/proxy.test.ts` —
  - Cache MISS with hint present → calls `fetchAtResolvedTime` with the hint's TS; does NOT call `fetchAtRequestedTime`.
  - Cache MISS with hint present + Tier 1 `not_found` → hint deleted, Tier 2 called.
  - Cache MISS without hint → Tier 2 called as today.
  - Tier 2 success → `writeHint` called with the resolved TS parsed from the redirect.
  - Prewarm hits an asset with matching hint → skips the upstream fetch (assert directClient NOT called).

- **Implement:** `src/services/proxy.ts` — add the lookup at the start of the MISS path; add the writes at Tier 1 / Tier 2 success.

- **Validation:** `pnpm test proxy.test.ts && pnpm typecheck`

### Research Enhancement

- **Exact insertion sites in `proxy.ts`:**
  - MISS-path hint READ: between `cache.lookup` (line 66) returning null and the `Tier 2` branch at line 70-72. Guard on `this.config.hintsEnabled` (or absence of kill-switch field).
  - Tier 1 success path on hint-driven `fetchAtResolvedTime`: write cache, `writeResolvedTimeSidecar(time, url, hint.embeddedTs)`, `writeContentTypeSidecar`, refresh hint (touch `observedAt`), `cacheStatus = "MISS_DIRECT"`. Same shape as the existing Tier 2 success block at `proxy.ts:73-83`.
  - Tier 1 `not_found` on hint: delete the hint (stale), then continue into the existing Tier 2 flow. Do NOT short-circuit to 404 from the hint alone — a hint-driven `not_found` could itself be wrong; Tier 2 is authoritative for 404.
  - Tier 1 `fallback` on hint: preserve the hint (transient 5xx), continue into existing Tier 2 flow.
  - Tier 2 success hint WRITE: inside the existing `if (direct.resolvedTime)` block at `proxy.ts:75-77`, after `writeResolvedTimeSidecar`:
    ```ts
    if (direct.resolvedTime) {
      await this.cache.writeResolvedTimeSidecar(time, targetUrl, direct.resolvedTime);
      await this.cache.writeHint(targetUrl, direct.resolvedTime);
    }
    ```
  - Prewarm hint WRITE: inside the existing fire-and-forget `.then` block at `proxy.ts:131-150`, after `writeContentTypeSidecar`. Existing `.catch` handles failures.
  - Prewarm hint CHECK (skip if matching): before invoking `fetchAtResolvedTime` for each `asset`. If `readHint(asset.url)` returns `{ embeddedTs }` matching `asset.embeddedTs`, refresh `observedAt` (re-write same JSON) and SKIP the upstream call. Emit the `[prewarm] duplicate-skip` info event (see Prewarm flow change enhancement).
- **Tests required (additions to `proxy.test.ts`, matching the existing `toHaveBeenCalledWith` style — no crash-recovery tests exist in this file today; not introducing them):**
  - MISS + hint present + Tier 1 `ok` → `fetchAtResolvedTime` called with `hint.embeddedTs`, `fetchAtRequestedTime` NOT called, hint `observedAt` refreshed.
  - MISS + hint present + Tier 1 `not_found` → hint deleted, `fetchAtRequestedTime` called.
  - MISS + hint present + Tier 1 `fallback` → hint preserved (assert `deleteHint` NOT called), `fetchAtRequestedTime` called.
  - MISS without hint → existing Tier 2 path (regression guard).
  - Tier 2 `ok` with `resolvedTime` set → `writeHint(url, resolvedTime)` called.
  - Tier 2 `ok` with `resolvedTime` undefined → `writeHint` NOT called (sits inside the existing `if (direct.resolvedTime)` block — same gate, no separate test logic).
  - Prewarm: asset with hint matching `asset.embeddedTs` → `fetchAtResolvedTime` NOT called, `[prewarm] duplicate-skip` info log emitted with `event=prewarm_duplicate_skip`.
  - Prewarm: asset with hint mismatch → `fetchAtResolvedTime` called with `asset.embeddedTs`, hint overwritten on success.
  - Stale sentinel + stale hint ordering: sentinel within `notFoundTtlDays` → `lookup` throws 404 BEFORE `readHint` is reached (assert `readHint` NOT called).
  - `HINTS_ENABLED=false` → `readHint` and `writeHint` never called even on MISS.
- **Sampling verifier (`HINT_VERIFY_SAMPLE_RATE`):** when a Tier 1 hint-driven `ok` happens, mock `Math.random` → fire background `fetchAtRequestedTime`, assert `[cache] hint-drift-detected` warn log when freshTs differs from hintTs. Sampling at 0 (default-off in tests) → no background call.
- **Ref:** repo-research-researcher (insertion-site analysis), best-practices-researcher (drift sampling pattern).

### Step 3: Config knob + cleanup CLI

- **Test:** `tests/models/config.test.ts` — `HINT_TTL_DAYS` parses with default 180, range 1–3650.

- **Implement:**
  - `src/models/config.ts` — add `HINT_TTL_DAYS`.
  - `src/services/cache.ts` — `handleCacheClear` learns a new `?hints=1` query param to wipe just the `.hints/` directories without touching cached bytes. Useful when Wayback re-indexes and we want to force re-resolution.

- **Validation:** `pnpm test config.test.ts && pnpm test cache.test.ts`

### Research Enhancement

- **Extra config knobs to add in this step:**
  - `HINTS_ENABLED` (bool, default `true`) — kill switch separate from the parent fast-path `DIRECT_FETCH_ENABLED`. Lets production disable hints while leaving the three-tier serving intact.
  - `HINT_TTL_DAYS` (int, default `180`, range `1–3650`) — sliding TTL, refreshed on every observation.
  - `HINT_VERIFY_SAMPLE_RATE` (float, default `0.01`, range `0–1`) — sampling for the embedded-TS-stability verifier (see Schema enhancement).
  - `HINT_LRU_MAX_ENTRIES` (int, default `5000`, range `100–100_000`) — in-memory LRU size.
  - `HINT_NEGATIVE_TTL_MS` (int, default `60_000`, range `0–3_600_000`) — negative-result LRU TTL.
  Existing config parse style (`config.ts:47-57` direct-fetch block) is the precedent — out-of-bounds rejected, default applied on absent.
- **`?hints=1` cache-clear semantics:**
  - Bare `?hints=1` (no `?domain`): `fs.rm(<cacheDir>/v2-hints, { recursive: true, force: true })`. Returns `{ deleted, total }` where `total` counts the host-dirs walked before removal.
  - `?hints=1&domain=*.example.com`: walk `<cacheDir>/v2-hints/<host>` and remove host-dirs matching `matchesDomain` (reuse the helper at `cache.ts:363-370`). Hint-only domain clear, leaves cached bytes intact.
  - Existing `?domain=*.example.com` (no `?hints` flag) → ALSO walk and prune matching hint host-dirs, so a domain wipe leaves no orphan hints pointing at deleted cache. This is the cross-interaction the original plan missed: without it, a domain reset leaves stale hints that drive Tier 1 against freshly-emptied bytes (self-healing on next request via `not_found` → delete-and-fall-through, but the user takes the latency hit).
  - Full clear (no `?domain`, no `?hints`): keep the existing `fs.rm(v2Root)` AND also `fs.rm(<cacheDir>/v2-hints)`. Two rm calls, both with `force: true`. Don't restructure into a shared parent root — that would be an in-place migration with no payoff.
- **Test additions (`cache.test.ts`):**
  - `handleCacheClear ?hints=1` removes only `v2-hints/`, leaves `v2/` untouched.
  - `handleCacheClear ?hints=1&domain=*.example.com` removes only matching host dirs under `v2-hints/`.
  - `handleCacheClear ?domain=*.example.com` (no `?hints`) removes BOTH `v2/<time>/<host>` matches AND `v2-hints/<host>` matches.
  - `handleCacheClear` with no params removes both v2 and v2-hints roots.
  - Config tests: each new knob parses with default, range-rejects out-of-bounds.
- **Ref:** repo-research-researcher (`handleCacheClear` walk pattern, config parsing precedent), best-practices-researcher (kill-switch + LRU sizing rationale).

## Acceptance Criteria

- [ ] After loading `/web/<ts>/site/page1.html` (prewarms 20 assets), loading `/web/<ts>/site/page2.html` does not re-fetch any of the 20 shared assets — verified by counting `[direct] resolved-fetch` log lines.
- [ ] Forcing a hint to expired-mtime causes the next request to delete it and fall through to Tier 2.
- [ ] `?hints=1` cache-clear wipes only hint files; cached asset bytes remain.
- [ ] `pnpm test` and `pnpm typecheck` both green.

## Out of Scope (Deferred from This Deferred Plan)

- Sharing hints across replicas (Redis-backed hint store). Same logic as the parent plan — single-replica deployment makes filesystem hints sufficient.
- Time-bucket hint variants (multiple `embeddedTs` for the same URL across different requested times). Not needed: Wayback's per-asset resolution is a function of the asset, not the requested page time.

## Enrichment Summary

**Deepened:** 2026-05-23
**Gaps found:** 17
**Agents used:** wiz:workflow:spec-flow-analyzer, wiz:research:repo-research-researcher, wiz:research:best-practices-researcher, wiz:research:git-history-researcher (partial)
**Second opinion:** no — `wiz-run second-opinion.js` timed out at 300 s (workflow fallback: proceed with agent findings)
**Confidence:** N/A — no inter-agent contradictions surfaced, synthesis step skipped

### Key Discoveries

- The plan's original path scheme (`<cacheRoot>/.hints/<sha-16>`) cannot achieve cross-page-time sharing because the existing `buildPerUrlSubpath` is time-scoped. Use `<cacheDir>/v2-hints/<host>/<sha-16>` — a new sibling root that introduces no migration and follows the v1→v2 clean-cutover precedent (commits `5abc398`, `e18006b`).
- Protocol-inclusive hashing in `buildPerUrlSubpath` would double the hint set for `http://`/`https://` references to the same asset. Hint hashing string is `${u.host}${u.pathname}${u.search}` — protocol-agnostic, www/apex preserved.
- The "embedded TS is stable across requested page-time" assumption has NO historical support in this repo. Add `HINT_VERIFY_SAMPLE_RATE=0.01` to sample-verify Tier 1 hits against `fetchAtRequestedTime` with drift logging.
- Sliding TTL (refresh `observedAt` on re-observation) is the right semantics; hard TTL silently expires actively-used hints. Idempotent via atomic tmp+rename.
- GCS FUSE adds 50–150 ms metadata round-trip per hint read. Add in-process `lru-cache` (5k entries, hint-TTL ms) + 60 s negative-result cache to keep the MISS path fast. `HINTS_ENABLED` kill switch provides the escape hatch.
- All existing per-URL sidecars (`.notfound`, `.resolved-time`, `.content-types`) bootstrap OPPORTUNISTICALLY — no backfill from existing cache data. Commit `ad996a6` explicitly handles missing-sidecar with a fallback. The hint plan should follow this precedent: hints accumulate from new MISSes only.
- Tier 1 hint-driven outcomes: `ok` → keep+refresh, `not_found` → delete, `fallback` (5xx) → preserve (transient blips don't invalidate the embedded TS).
- Existing `?domain=*.example.com` cache-clear must be extended to ALSO walk `v2-hints/<host>`, otherwise domain wipes leave orphan hints pointing at empty cache dirs.
- Observability: the trigger query (>30% duplicate `(url, embeddedTs)` pairs/hour) needs an info-level `[prewarm] duplicate-skip` event with `{ event: "prewarm_duplicate_skip", url, embeddedTs, hintAge }` — the current `debug`-level `[direct] resolved-fetch` log gets dropped by Cloud Run's typical `info+` retention.
- Corruption recovery: return null + warn, never `unlink`. TOCTOU race against concurrent atomic writers would lose valid hints. Next `writeHint` overwrites cleanly via rename.

### New Risks Identified

- **Embedded-TS drift across page-time** (severity: medium) — undocumented Wayback behavior; could serve "wrong-snapshot" bytes for an asset if the resolution actually does depend on page-time. Mitigation: `HINT_VERIFY_SAMPLE_RATE` sampling + warn-on-drift logs. If drift is observed in production, raise sample rate and add a Tier 1→Tier 2 cross-check on every hit until policy is settled.
- **GCS FUSE latency on the MISS path** (severity: medium) — extra `fs.readFile` per MISS adds 50–150 ms; can compound under prewarm bursts. Mitigation: LRU layer (positive + negative) + `HINTS_ENABLED` kill switch. Validate in staging before enabling in prod.
- **Orphan hints after domain cache-clear** (severity: low) — without the `?domain` cross-walk extension, hints survive a domain wipe and drive Tier 1 against the now-empty cache. Self-healing on next request via `not_found` → delete-and-fall-through, but adds a latency spike for the first asset per URL.
- **Race between concurrent `writeHint` for different `embeddedTs` values** (severity: low) — DedupingDirectClient handles same-`(url, ts)`; different-`ts` races resolve via POSIX rename atomicity to last-writer-wins. Documented as a known semantic, no fix needed.
- **Hint write amplification on cold deployments** (severity: low) — sliding TTL writes 10k+ small JSON files/day on a typical archived site. Fire-and-forget; saturates GCS API budget only on cold-restart days when prewarm runs full-tilt.

### Items NOT Changed (and why)

- `## Acceptance Criteria` retained verbatim per workflow rules. New criteria implied by enhancements (drift sampling, `?domain` hint cross-walk, LRU population) should be lifted into the criteria list at story-creation time via `/wiz:stories create`.
- Step header structure (`### Step N:`, `**Test:**`, `**Implement:**`, `**Validation:**`) retained verbatim so `wiz:work` parses correctly. All enrichment lives in adjacent `### Research Enhancement` subsections.

## Triggering Condition Recap

Do not implement this plan until:
- The Direct-Fetch Fast Path plan is shipped and stable in production.
- Production logs show measurable duplicate prewarm work (>30% duplicate `(url, embeddedTs)` pairs over a representative time window) OR a user-facing complaint about asset bandwidth.
