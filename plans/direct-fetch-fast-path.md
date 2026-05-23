---
status: in_progress
approved_at: "2026-05-23T01:01:40.107Z"
updated: "2026-05-23T01:06:42.935Z"
started_at: "2026-05-23T01:06:42.935Z"
---
# Plan: Direct-Fetch Fast Path for Asset MISSes (Embedded-Timestamp Edition)

**Created:** 2026-05-22 | **Revised:** 2026-05-23 | **Status:** Draft | **Effort:** M | **Branch:** wip/modular-refactor-pnpm-turborepo

## Summary

Eliminate the CDX snapshot-resolution step for assets referenced in Wayback-rewritten HTML/CSS. Wayback already embeds the resolved capture timestamp in every `<img src>`, `<link href>`, `url(...)`, etc. it rewrites — e.g. `<img src="/web/20010912093045im_/http://a772.g.akamai.net/.../4.gif">`. The proxy currently captures that timestamp in `RE_ARCHIVE_URL` and **throws it away**, asking CDX to recompute it. CDX then 30s-times-out (see akamai failures in production logs, 2026-05-23) and the asset 502s.

Three tiers, fastest first:

1. **Prewarm (primary):** during HTML/CSS rewrite, collect `(originalUrl, embeddedTs)` pairs and fire-and-forget `GET https://web.archive.org/web/<embeddedTs>id_/<url>` into the cache. By the time the browser requests the asset, it's a HIT. No CDX. No redirect.
2. **Direct fetch with requested-TS (fallback):** if the browser races prewarm or the asset wasn't in the HTML, fetch `https://web.archive.org/web/<requestedTs>id_/<url>` with `redirect: "follow"`. One round-trip + a 302 to find the resolved TS. Still no CDX.
3. **Worker (last resort):** existing CDX → snapshot-resolver → downloader pipeline. Only triggered when both direct paths fail (5xx from Wayback edge, non-HTML-discovered URLs that 404 the direct endpoint, etc.).

Expected impact for a cold page load of `/web/20010912000000/http://www.apple.com/`:
- Asset MISSes drop from 30–120s (CDX timeout + retry + worker queue serialization) to ~50–300ms (single CDN hit).
- Worker queue stays mostly idle on page loads — reserved for crawls and exotic edge cases.
- CDX traffic falls to ~0 for asset MISSes, removing the rate-limit-induced 502 cascade visible in the logs.

## Architecture Context

- Request path: `TimeMachineService` → `ProxyService.fetch(url, time)` → `cache.lookup` → on MISS, `archiveJobClient.enqueueExactAndWait` (worker → snapshot-resolver → downloader → cache file → re-lookup).
- Bottleneck #1: snapshot-resolver in `src/lib/snapshot-resolver.ts` fires up to 4 URL variants (http/https × www/bare) against CDX in parallel, each with 3 retries × 30s timeout. When CDX is unhealthy for a host (akamai's case), this burns 90–360s before giving up and writes no negative-cache sentinel (`snapshot-resolver.ts:92-96` — correct policy on indeterminate state, but it means the next page load replays the storm).
- Bottleneck #2: worker rate limit `WORKER_RATE_LIMIT_PER_SEC=1` serializes 15+ asset MISSes from a single cold page load.
- Wayback's HTML rewriter encodes resolved timestamps into asset references using the pattern `(?:https?://web\.archive\.org)?/web/(\d{14})(?:[a-z]{1,3}_)?/(https?://.+)`. The proxy's existing `RE_ARCHIVE_URL` (`url-rewriter.ts:17-18`) captures both groups — timestamp and original URL — but `rewriteOneUrl` discards the timestamp by passing only `archive[2]` (the URL) into `buildProxyUrl(originalUrl, fallbackTime)`. The "fallback time" is the page-level requested time, which is what the cache key is built from and what the resolver then re-resolves.
- Wayback's `id_` suffix returns raw asset bytes without toolbar/URL injection. The proxy reads from cache and applies its own HTML/CSS rewriting after read, so storing raw bytes is correct.
- `installOutboundProxy` (`src/lib/outbound-proxy.ts`) installs a global undici dispatcher — every `fetch()` egresses through configured proxies. Both direct-fetch tiers inherit this for free.
- `ArchiveJobClient` already deterministically dedups concurrent foreground worker requests via `jobId = sha256(url|time)`. Prewarm needs an equivalent in-memory dedup so a page with 15 `<img>` tags pointing to the same sprite triggers 1 upstream fetch.

## Research Findings

- **Concrete evidence of the failure mode** (production logs, 2026-05-23): job `e-fdfed059bdd94a40` for `http://a772.g.akamai.net/.../4.gif` at `20010912000000` failed with all four URL variants reporting `kind: "transport", detail: "fetch failed", elapsedMs: 32839` from snapshot-resolver. Eight different akamai assets failed identically across ~60s of wall-clock. The original Apple 2001 HTML referenced each of these with an embedded resolved timestamp; the proxy's current code path never reached that data.
- `src/lib/url-rewriter.ts:202-203` — `rewriteOneUrl`: matches `RE_ARCHIVE_URL`, captures `(ts, url)`, then calls `buildProxyUrl(url, fallbackTime)`. The captured `ts` is the resolved timestamp. **This is the single-line origin of the data loss.**
- `src/lib/url-rewriter.ts:227-231` — `rewriteCssUrls` has the same shape: regex-replace `url(...)` with `rewriteOneUrl`. CSS files served from cache also contain embedded-TS references (Wayback rewrites them on capture). Prewarm must run on CSS too.
- `src/services/proxy.ts:60-77` — the insertion point for prewarm trigger (after HTML rewrite, before response return) and for the direct-fetch fallback (between `cache.lookup` MISS and `archiveJobClient.enqueueExactAndWait`).
- `src/services/cache.ts:46-50, 62-66` — path-traversal guard (`startsWith(root + sep)`). The new cache-write helper must mirror this exactly; cleanest is a shared `computeAbsPath` private helper used by both `lookup` and a new `writeFile`.
- `src/services/cache.ts:104-122` — `writeNotFoundSentinel` and `writeResolvedTimeSidecar` already exist; reuse for negative cache and per-host resolved-time bookkeeping.
- `src/clients/archive-job-client.ts` — port pattern (`ArchiveJobClientPort`) to mirror for the new direct client.
- Wayback `web/<ts>id_/<url>` redirects to `web/<resolved-ts>id_/<url>` (suffix preserved). For Tier 2 (requested-TS fallback), `redirect: "follow"` is safe; parse `response.url` to extract the resolved timestamp for the sidecar.
- `WORKER_RATE_LIMIT_PER_SEC=1` is a global token bucket via BullMQ `limiter`; raising it before eliminating the foreground worker dependency does not help cold-page latency.

## Security Considerations

- Target URL is validated by `TimeMachineService.validateTargetUrl` before reaching `ProxyService.fetch` — both direct tiers inherit this.
- **Embedded timestamps must be re-validated.** A malicious archived page could rewrite an asset URL with a malformed/oversized timestamp. The embedded TS goes directly into a URL the proxy fetches from `web.archive.org`, so the risk is bounded (worst case: a 404 from Wayback), but constructing the URL still requires sanitization. Apply `/^\d{14}$/` to every embedded TS before constructing the upstream URL; on mismatch, drop the embedded TS and fall through to Tier 2.
- Upstream URL construction: `` `https://web.archive.org/web/${ts}id_/${targetUrl}` ``. `targetUrl` is a literal pathname segment (Wayback does not require encoding here; encoding the colon would break the protocol).
- File writes go through `CacheService.writeFile` which re-applies the path-traversal guard — no new attack surface beyond what `lookup` already permits.
- Prewarm is server-initiated. Asset URLs come from HTML the proxy itself just fetched from `web.archive.org`. They are bounded to what Wayback rewrote — no user-supplied URLs reach prewarm.

## Performance Considerations

- Hot path: every HTML page load that references uncached assets. Today: 15 sequential MISSes at ~30s each (worker serialized at 1/s, plus CDX timeouts) = 30s–8min. After: 15 parallel direct fetches at ~200ms each, bounded by a concurrency semaphore = ~500ms total.
- **Prewarm bandwidth cost.** A 100-asset page triggers 100 background fetches. Same bandwidth as if the browser had asked, just shifted to the server. Cap prewarm to the first 100 discovered URLs per page to bound exposure (large media files via `<video src>` skipped unless explicitly requested).
- **In-flight dedup.** In-process `Map<string, Promise<DirectResult>>` keyed by `${url}|${ts}`. Without it, a sprite referenced 15 times in HTML triggers 15 upstream fetches. Entries are deleted on settle (no unbounded growth).
- **Concurrency cap.** Semaphore default 10. Wayback's snapshot CDN tolerates higher concurrency than CDX — initial conservative cap; can raise after measurement.
- **Atomic writes.** Prewarm and on-demand fetch may race (browser asks for the same asset prewarm is writing). Tmp-file + rename on the cache write prevents truncated reads.
- **Memory.** Discovered-assets list per page is bounded (≤ ~hundreds of references). Held only for the duration of the HTML response.

## Steps

### Step 1: `CacheService.writeFile` (atomic write) + shared abs-path helper

- **Test:** `tests/services/cache.test.ts` —
  - `computeAbsPath` returns the same path `lookup` probes for a given `(url, time)`.
  - Path-traversal payloads in the URL pathname (`/%2e%2e/etc/passwd`) reject with 400.
  - `writeFile(url, time, buf)` round-trips: subsequent `lookup` returns the bytes.
  - Atomic semantics: a partially-written tmp file does not satisfy `lookup` (the rename is the visibility boundary).
- **Implement:** `src/services/cache.ts` —
  - Extract abs-path computation from `lookup` into `private computeAbsPath(url, time): string` (single source of truth for the traversal guard).
  - Add `async writeFile(url: string, time: string, body: Buffer): Promise<void>`:
    ```ts
    async writeFile(url: string, time: string, body: Buffer): Promise<void> {
      const abs = this.computeAbsPath(url, time);
      await fs.mkdir(dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, abs);
    }
    ```
- **Constraint:** `computeAbsPath` is the only place the traversal guard lives. `lookup` and `writeFile` both call it. A divergence between read-path and write-path is structurally impossible.
- **Validation:** `pnpm test cache.test.ts`

### Step 2: `url-rewriter` collects discovered `(url, embeddedTs)` pairs

- **Test:** `tests/lib/url-rewriter.test.ts` —
  - Given HTML with `<img src="/web/20010912093045im_/http://a/b.gif">`, returned `discoveredAssets` includes `{ url: "http://a/b.gif", embeddedTs: "20010912093045" }`.
  - Plain relative URL `<img src="/c.gif">` (no embedded TS) is rewritten as today but NOT added to `discoveredAssets`.
  - Duplicate refs (same URL twice in HTML) deduplicate to a single entry.
  - Malformed timestamps (`/web/abc/...`) — rewriter already rejects in `RE_ARCHIVE_URL`; assert no entry added.
  - Same coverage for `srcset`, `<style>` inline CSS, `style="..."` attribute, `<meta http-equiv="refresh">` URL portion, and bare CSS files via `rewriteCssUrls`.
- **Implement:** `src/lib/url-rewriter.ts` —
  - Change signature: `rewriteHtmlUrls(html, targetUrl, time): { html: string; discoveredAssets: DiscoveredAsset[] }`. Same shape for `rewriteCssUrls`.
  - `DiscoveredAsset = { url: string; embeddedTs: string }`. Validation: only push when `/^\d{14}$/.test(embeddedTs)`.
  - Collect via a `Set<string>` keyed by `${url}|${embeddedTs}` inside the visit closure; flush to an array at the end.
  - **Backward compat:** the new return shape is a strict superset — callers that ignore `discoveredAssets` get the same `html` string they get today. Update `ProxyService` (the only caller) in Step 5.
- **Constraint:** `consumeBaseTag` and `visit` already walk the parse5 tree. Don't add a second pass — instrument the existing one. Cost: one set insert per archived URL.
- **Validation:** `pnpm test url-rewriter.test.ts`

### Step 3: `WaybackDirectClient` — resolved-TS primary + requested-TS fallback

- **Test:** `tests/clients/wayback-direct-client.test.ts` — mock `globalThis.fetch`:
  - `fetchAtResolvedTime(url, ts)`:
    - 200 → `{ outcome: "ok", bytes }`. Constructs `https://web.archive.org/web/<ts>id_/<url>` literally; no redirect follow needed.
    - 404 → `{ outcome: "not_found" }`.
    - 5xx / throw → `{ outcome: "fallback", reason }`.
    - Malformed `ts` (not 14 digits) → `{ outcome: "fallback", reason: "bad-timestamp" }`.
  - `fetchAtRequestedTime(url, ts)`:
    - 200 with `response.url` matching `/web/<resolved>id_/...` → `{ outcome: "ok", resolvedTime, bytes }`.
    - 404 → `{ outcome: "not_found" }`.
    - 5xx / throw → `{ outcome: "fallback", reason }`.
    - Uses `redirect: "follow"`.
  - Both: respect `DIRECT_FETCH_TIMEOUT_MS` via `AbortSignal.timeout`.
- **Implement:** `src/clients/wayback-direct-client.ts` —
  ```ts
  export type DirectResult =
    | { outcome: "ok"; resolvedTime: string | null; bytes: Buffer }
    | { outcome: "not_found" }
    | { outcome: "fallback"; reason: string };

  export interface WaybackDirectClientPort {
    fetchAtResolvedTime(targetUrl: string, resolvedTs: string): Promise<DirectResult>;
    fetchAtRequestedTime(targetUrl: string, requestedTs: string): Promise<DirectResult>;
  }
  ```
  Single concrete class implementing both. `fetchAtResolvedTime` sets `redirect: "manual"` and treats any 3xx as `fallback` (the resolved TS is supposed to be canonical — a redirect signals our TS is stale or wrong). `fetchAtRequestedTime` sets `redirect: "follow"` and parses `response.url` via `/\/web\/(\d{14})id_\//`.
- **Token-bucket rate limiter** (separate from per-page semaphore): both methods pass through a shared `TokenBucket(rate=DIRECT_FETCH_RATE_PER_SEC, burst=DIRECT_FETCH_BURST)` before issuing the upstream fetch. Default rate=20/s, burst=30. The semaphore caps **concurrency** (max in-flight at one moment); the bucket caps **sustained rate** (no more than N/s averaged over time). Both are needed: a semaphore at 10 with sub-second fetches still does hundreds of req/sec. Wayback's `id_` endpoint is CDN-fronted but they 429 aggressive scrapers — getting throttled at the moment our fast path actually works would be embarrassing.
- **Constraint:** Use `globalThis.fetch` (not a top-level import alias) so jest can stub per-test. The undici dispatcher installed by `installOutboundProxy` applies regardless.
- **Validation:** `pnpm test wayback-direct-client.test.ts` (includes a fake-timer test confirming bucket refill cadence)

### Step 4: `DedupingDirectClient` decorator (in-flight dedup + concurrency semaphore)

- **Test:** `tests/clients/deduping-direct-client.test.ts` —
  - Two concurrent `fetchAtResolvedTime(url, ts)` calls invoke the inner client once; both receive the same result.
  - Errors clear the in-flight entry (a failing call does not poison the dedup map).
  - Concurrency cap: with cap=2 and 5 concurrent calls to distinct URLs, only 2 underlying calls are in flight at any moment.
  - `fetchAtResolvedTime` and `fetchAtRequestedTime` dedup independently (a resolved-TS call does not satisfy a requested-TS call for the same URL).
- **Implement:** `src/clients/deduping-direct-client.ts` — decorator over `WaybackDirectClientPort`. Two `Map<string, Promise<DirectResult>>` (one per method) + a shared semaphore.
- **Constraint:** Dedup is in-process. Two Node processes still race — acceptable today (single-process deployment); revisit when scaling horizontally.
- **Validation:** `pnpm test deduping-direct-client.test.ts`

### Step 5: Wire prewarm + fallback tiers into `ProxyService.fetch`

- **Test:** `tests/services/proxy.test.ts` —
  - **HTML HIT with prewarm:** serving HTML triggers `directClient.fetchAtResolvedTime` for each `discoveredAsset` (mock returns `ok`); each result is written to cache. Response returns before prewarm settles (assert `directClient` calls happen via `setImmediate`/microtask, not awaited in the response path).
  - **HTML MISS:** Tier 2 fallback (`fetchAtRequestedTime`) for the page itself returns `ok` → cache populated, `enqueueExactAndWait` NOT called, `cacheStatus: "MISS_DIRECT"`.
  - **Tier 2 `not_found` on page → 404** + sentinel written, no worker call.
  - **Tier 2 `fallback` on page → worker tier** (`enqueueExactAndWait`), `cacheStatus: "MISS_WORKER"`.
  - **Asset MISS (no embedded-TS hint available):** Tier 2 → Tier 3, same flow as page MISS.
  - **Prewarm error handling:** a prewarm `fallback` result for one asset does NOT prevent the HTML response from sending; logged at info, not propagated.
- **Implement:** `src/services/proxy.ts` —
  - Inject `WaybackDirectClientPort` via constructor. Wire in `src/lib/dependencies.ts` (compose `WaybackDirectClient` → `DedupingDirectClient`).
  - On HTML response: after `rewriteHtmlUrls`, kick off prewarm:
    ```ts
    const { html: rewrittenHtml, discoveredAssets } = rewriteHtmlUrls(stripped, targetUrl, time);
    body = rewrittenHtml;
    void this.prewarmAssets(discoveredAssets, time);
    ```
  - On CSS response: same with `rewriteCssUrls`.
  - On cache MISS for the requested URL: `fetchAtRequestedTime` first (Tier 2), worker on `fallback` (Tier 3), 404 on `not_found`.
  - `prewarmAssets`: for each `{ url, embeddedTs }`, call `directClient.fetchAtResolvedTime(url, embeddedTs)` (deduped + gated). On `ok`, write to cache under the page's requested time so the browser-facing URL `/web/<page-ts>/<asset>` is a HIT. On `not_found`, write a sentinel. On `fallback`, do nothing (the browser request will retry via Tier 2/3).
- **Constraint:** `ProxyResult.cache` widens from `"HIT" | "MISS"` to `"HIT" | "MISS_DIRECT" | "MISS_WORKER"`. Update `src/models/proxy.ts`. `time-machine.ts` maps both MISS variants to `MISS` for the `X-Cache` response header (client compat) but logs the internal variant.
- **Constraint:** Prewarm is fire-and-forget. The HTML response must NOT await its completion — that would re-introduce the latency we're trying to eliminate. Use `void` on the promise and ensure no `unhandledRejection` leaks (the dedup wrapper catches and converts everything to `DirectResult`, so this should be inherent).
- **Validation:** `pnpm test proxy.test.ts && pnpm typecheck`

### Step 6: Configuration knobs + observability

- **Test:** `tests/models/config.test.ts` — new env vars parse with defaults; out-of-bounds rejected.
- **Implement:** `src/models/config.ts` —
  - `DIRECT_FETCH_ENABLED` (bool, default `true`) — kill switch. When false, `dependencies.ts` substitutes a passthrough that always returns `{ outcome: "fallback", reason: "disabled" }`, so all traffic flows through the worker.
  - `DIRECT_FETCH_MAX_CONCURRENT` (int, default `10`, range 1–50).
  - `DIRECT_FETCH_TIMEOUT_MS` (int, default `15000`, range 1000–60000).
  - `DIRECT_FETCH_RATE_PER_SEC` (int, default `20`, range 1–100) — token-bucket sustained rate.
  - `DIRECT_FETCH_BURST` (int, default `30`, range 1–200) — token-bucket burst capacity.
  - `PREWARM_ENABLED` (bool, default `true`) — separate kill switch for the HTML-prewarm path. Lets us disable prewarm while keeping Tier 2 active (or vice versa) during incident response.
  - `PREWARM_MAX_ASSETS_PER_PAGE` (int, default `100`, range 0–500) — cap discovered assets queued per HTML/CSS response.
  - `NOT_FOUND_TTL_DAYS` (int, default `30`, range 1–3650) — negative-cache sentinel TTL. `CacheService.lookup` reads sentinel mtime; if `Date.now() - mtime > TTL`, it deletes the sentinel and returns null (treats it as never having existed). Without this, a Wayback backfill — common for less-indexed hosts like akamai mirrors — stays invisible forever. ~10 LOC change inside `lookup`'s existing sentinel-check branch.
- **Observability (structured logs, no metrics infra wired yet):**
  - `[direct] resolved-fetch ok|not_found|fallback` per asset, with `url`, `ts`, `bytes`, `elapsedMs`.
  - `[prewarm] page=<url> discovered=<n> queued=<n>` once per HTML/CSS response.
  - `[direct] requested-fetch ok|not_found|fallback` per Tier 2 call.
  - `[direct] rate-limited waited=<ms>` when the token bucket gates a fetch (info-level — visibility on whether the cap is too low).
  - `[cache] sentinel-expired url=<url>` when `lookup` invalidates a stale 404 sentinel.
  - Existing worker log lines unchanged.
- **Validation:** `pnpm test config.test.ts && pnpm test cache.test.ts`

### Step 7: Runtime URL-rewriter shim for JS-built URLs

- **Problem:** Static URLs in HTML are rewritten server-side by `rewriteHtmlUrls`. URLs constructed at runtime by page JS (`document.write('<img src="...">')`, `fetch('/api/foo')`, `new Image().src = ...`, dynamic React/Vue rendering) bypass that rewriter entirely. Wayback's wombat.js handles this by monkey-patching the relevant browser APIs at load time; we strip the toolbar that injects wombat. Without a replacement, pages with runtime URL construction (common in 1999–2005 archived sites — `document.write` everywhere) load some assets correctly and silently 404 others. Prewarm makes the static case fast but doesn't touch this gap.

- **Test:** `tests/lib/runtime-shim.test.ts` — jsdom-based:
  - Calling patched `fetch('/foo.gif')` after shim load issues a request to `/web/<pageTs>/<originalPageOrigin>/foo.gif`, not `/foo.gif`.
  - `new Image()` with `src = "http://example.com/x.png"` rewrites the property setter.
  - `document.write('<img src="/bar.gif">')` writes rewritten HTML.
  - `XMLHttpRequest.open("GET", "/api/foo")` rewrites the URL arg.
  - MutationObserver catches dynamically-inserted `<script src="...">`, `<link href="...">`, `<iframe src="...">`.
  - `data:`, `blob:`, `javascript:`, `mailto:`, `#anchor` URLs pass through unchanged.
  - Already-prefixed URLs (`/web/<ts>/...`) pass through unchanged (idempotent).
  - Relative URLs (`./foo.gif`, `foo.gif`) resolve against the original page URL, not the proxy URL.

- **Implement:** `src/lib/runtime-shim.ts` — exports a function that returns the shim JS as a string (template-literal). Approx 150 LOC. The shim:
  1. Reads `data-ts` and `data-url` attrs from `<meta name="wayback-context">` (injected by `rewriteHtmlUrls`).
  2. Defines `rewrite(url)` that handles: opaque schemes (passthrough), already-rewritten URLs (passthrough), absolute URLs (prefix with `/web/<ts>/`), relative URLs (resolve against `pageOriginalUrl` first, then prefix).
  3. Monkey-patches: `window.fetch`, `XMLHttpRequest.prototype.open`, `HTMLImageElement.prototype` (`src`/`srcset` setters), `HTMLScriptElement.prototype.src`, `HTMLLinkElement.prototype.href`, `HTMLIFrameElement.prototype.src`, `HTMLAnchorElement.prototype.href` (for clicks), `document.write` / `document.writeln` (regex-rewrite URL attrs in the HTML string), `window.open`, `EventSource`, `WebSocket`.
  4. Installs a `MutationObserver` on `document.documentElement` (childList + subtree) catching dynamically-inserted nodes with URL attrs.
  5. Wrapping: an IIFE so the shim has no globals leak; runs to completion before any subsequent script executes (placed first in `<head>`).

- **Inject in `url-rewriter.ts`:** after `consumeBaseTag`, before returning serialized HTML, insert two nodes at the top of `<head>`:
  - `<meta name="wayback-context" data-ts="..." data-url="...">`
  - `<script>${runtimeShimSource}</script>`

  The shim is small enough to inline (no extra round-trip). If we ever want caching, a future change can serve it from `/static/shim.js?v=<hash>` and `<script src="...">` it instead.

- **Code (shim skeleton):**
  ```ts
  // src/lib/runtime-shim.ts
  export const runtimeShimSource = `(function(){
    var meta = document.querySelector('meta[name="wayback-context"]');
    if (!meta) return;
    var pageTs = meta.getAttribute('data-ts');
    var pageUrl = meta.getAttribute('data-url');
    var PROXY_PREFIX = '/web/' + pageTs + '/';
    var SKIP_RE = /^(?:data:|blob:|javascript:|mailto:|tel:|sms:|about:|#)/i;

    function rewrite(u) {
      if (!u || typeof u !== 'string') return u;
      if (SKIP_RE.test(u)) return u;
      if (u.indexOf('/web/') === 0) return u;
      try {
        var abs = new URL(u, pageUrl).href;
        return PROXY_PREFIX + abs;
      } catch (e) { return u; }
    }

    var origFetch = window.fetch;
    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? rewrite(input) : input;
      if (input && typeof input === 'object' && 'url' in input) {
        url = new Request(rewrite(input.url), input);
      }
      return origFetch.call(this, url, init);
    };

    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) {
      var args = [m, rewrite(u)];
      for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
      return origOpen.apply(this, args);
    };

    // ... (Image/Script/Link/Iframe property descriptors)
    // ... (document.write regex rewrite)
    // ... (MutationObserver)
  })();\`;
  ```

- **Constraint:** The shim is sandbox-safe (no \`eval\`, no \`Function(...)\`). It runs BEFORE the preload scanner kicks in only if placed in the first chunk of \`<head>\` — which is why injection point matters. Document the limitation: URLs constructed inside Web Workers run in a separate global; covering them requires patching the \`Worker\` constructor to wrap the worker script source, which is significantly more invasive. **Out of scope for this step**; documented in the new \`plans/runtime-shim-worker-coverage.md\` (to be created if/when needed).

- **Constraint:** The shim must not break pages that already work. If \`pageOriginalUrl\` is malformed (shouldn't happen — proxy controls it), the \`URL\` constructor throws and \`rewrite\` returns the input unchanged. Safe degradation.

- **Validation:** \`pnpm test runtime-shim.test.ts && pnpm typecheck\`

## Acceptance Criteria

- [ ] Cold page load of `/web/20010912000000/http://www.apple.com/` resolves every akamai asset that previously failed (`a772.g.akamai.net/.../{1a,4,6,1right,spacer,retail08092001}.gif/jpg`) in under 5s wall-clock, with zero CDX requests for those assets. **[MANUAL]** — verified by `docker logs` showing no `[snapshot-resolver]` lines for those URLs during the page load.
- [x] `docker logs` shows `cache: MISS_DIRECT` for assets served via Tier 2; `MISS_WORKER` only on direct fallback or for non-HTML-discovered URLs.
- [x] `[prewarm]` log lines confirm assets are queued from HTML rewrite.
- [x] 404 assets return 404 with a sentinel written; the second request returns 404 in <50ms.
- [ ] Negative-cache TTL works: forcing a sentinel's mtime to `now - 31d` causes the next `lookup` to delete it (verified by integration test, not just unit).
- [x] Direct-fetch failure (simulate via outbound proxy block to `web.archive.org`) falls back to worker path and still serves.
- [ ] **JS-built URLs resolve via the shim.** Load a page known to use `document.write` for asset injection (e.g. a 2002-era page with rotating banner scripts); browser issues asset requests via the proxy path, not the proxy origin's bare host. **[MANUAL]** — verified by network-tab inspection.
- [ ] Token bucket gates burst behavior: a synthetic test load of 100 concurrent prewarm fetches with rate=20/s shows no more than 50 requests issued in the first second (burst=30 + steady=20).
- [x] `pnpm test` and `pnpm typecheck` both green.
- [x] `DIRECT_FETCH_ENABLED=false` reverts to worker-only behavior (regression-safety kill switch).
- [x] No regression in domain-crawl behavior — that path does not touch the direct fetcher.

## Checklist (non-TDD cleanup)

- [ ] Update `README.md` with the four new env vars and the three-tier serving model.
- [ ] Lint clean (`pnpm lint`).
- [ ] Confirm `X-Cache` response header still emits `HIT`/`MISS` for backward compat; log internal variant separately.
- [ ] Verify prewarm respects `installOutboundProxy` rotation (manual log check after a real page load).
- [ ] **After validation in staging:** raise `WORKER_RATE_LIMIT_PER_SEC` from 1 to 5 in `.env`. The worker now handles only non-HTML-discovered URLs, so the rate cap matters less.
- [ ] Delete obsolete TODO/DEFERRED comments touched during the refactor.

## Out of Scope (Deferred, Each Tracked)

Items deferred from this plan. Each has its own follow-up plan or measurement gate so nothing is silently dropped.

- **Cross-process dedup (Redis-backed).** Stays OOS while we deploy at single-replica Cloud Run. Detection plan: the `[prewarm] discovered=<n> queued=<n>` log lines include the hostname; a downstream log query that surfaces duplicate `queued` events across instances within a 5s window is the trigger to revisit. No follow-up plan file until measurement justifies one.
- **Persisted `(url, embeddedTs)` hints across page loads.** Deferred to `plans/persisted-embedded-ts-hints.md` (created alongside this plan). Optimization for shared assets across pages of an archived site (sprites, common CSS). Tier 2 absorbs the cost of one redirect per first-MISS-after-eviction in the meantime.
- **Streaming HTML response while prewarm is in flight.** parse5's `serialize()` is one-shot; real streaming requires switching to `htmlparser2` or `parse5-sax-parser`. Estimated TTFB win: 50–150ms — wrong order of magnitude versus the 30s → 500ms win from prewarm. Revisit when TTFB shows up as a top user-facing complaint, not before.
- **Changing the cache key to include the resolved timestamp.** Would enable cross-time cache reuse for the same asset bytes. Layout change touches `lookup`, `writeFile`, `writeNotFoundSentinel`, `handleCacheClear`, and the GCS bucket structure. Disk cost is currently negligible (assets <100KB, duplication factor low). Revisit if/when GCS bill becomes visible.
- **Web Worker URL coverage for the runtime shim (Step 7).** The shim patches the main-thread global; URLs constructed inside `Worker` threads run in a separate global and bypass the patches. Covering them requires intercepting the `Worker` constructor to wrap the worker script source (transitively inject the shim). Significant complexity. Documented as a limitation in the shim's source comments; deferred to a future plan if/when we encounter an archived page that depends on it.
- **Prometheus metrics.** No metrics infrastructure currently wired in this project. Structured log lines (Step 6) are sufficient for acceptance validation via `docker logs`. Retrofitting counters into Step 1–7 code is a 30-minute job once Prometheus infra exists project-wide.
