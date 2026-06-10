# CSS Inlining Design

**Date:** 2026-06-10  
**Status:** Approved

## Problem

When serving archived HTML pages, `<link rel="stylesheet">` tags are rewritten to point at proxy URLs. In div-based content frames and WebSocket clients the browser cannot make the secondary requests those links require, so pages render unstyled.

## Goal

Inline all `<link rel="stylesheet">` stylesheets as `<style>` blocks in the HTML response, so CSS is self-contained and works in any rendering context.

## Scope

- Always-on for every HTML response (no opt-in flag).
- If the CSS is not in cache when the HTML is served, fetch it live and block before responding.
- If the fetch fails for any reason, leave the `<link>` tag as-is (graceful degradation).
- No worker (Tier 3) fallback for CSS fetching — blocking the page response on a BullMQ job for a secondary stylesheet resource is not acceptable. If the direct fetch fails and the cache is cold, degrade gracefully.

---

## Architecture

### New function: `inlineCssLinks`

Location: `src/lib/url-rewriter.ts`

```ts
export async function inlineCssLinks(
  html: string,
  fetchCss: (cssUrl: string, ts: string) => Promise<string | null>,
  time: string,
  lockTime: boolean,
  proxyBase: string,
): Promise<string>
```

`targetUrl` (the HTML page's URL) is **not** in the signature. By the time `inlineCssLinks` runs, `rewriteHtmlUrls` has already rewritten all `<link href>` values to proxy format. `inlineCssLinks` extracts `cssUrl` and `ts` from each proxy-format href, passes them to `fetchCss`, and uses `cssUrl` as the base for `rewriteCssUrls`. Any `<link>` whose href is not a valid proxy-format URL (i.e. `RE_WAYBACK_PATH` does not match after stripping the `proxyBase` origin) is silently left as-is.

**Two-parse tradeoff:** `inlineCssLinks` receives the serialized HTML string from `rewriteHtmlUrls` (already a string) and re-parses it with parse5 before serializing again. This is a deliberate choice: keeping `rewriteHtmlUrls` synchronous and its signature unchanged avoids a disruptive change to a heavily-tested function. The double-parse overhead is acceptable for archived pages (typically a few KB of late-1990s HTML). The correctness risk from parse → serialize → parse non-idempotency (e.g. SVG, CDATA) is low in practice for this corpus but is an acknowledged tradeoff.

`fetchCss` receives the already-resolved `(cssUrl, ts)` pair — not the raw proxy href. Resolving the proxy href into this pair is `inlineCssLinks`'s responsibility.

Called by `ProxyService.fetchCore` immediately after `rewriteHtmlUrls`. The `fetchCss` callback is built by `this.buildCssFetcher()` — a private method that closes over `this.cache` and `this.directClient`.

### `buildCssFetcher` signature

```ts
private buildCssFetcher(): (cssUrl: string, ts: string) => Promise<string | null>
```

Returns a callback that: looks up the CSS in cache → reads from disk on hit → direct-fetches on miss → writes cache sidecars → returns the CSS string. Returns `null` on any error (never throws).

### Call site change in `ProxyService.fetchCore`

Current (abbreviated):
```ts
const { html, discoveredAssets } = rewriteHtmlUrls(stripped, targetUrl, time, ...);
body = html;
```

After:
```ts
const { html, discoveredAssets } = rewriteHtmlUrls(stripped, targetUrl, time, ...);
body = await inlineCssLinks(html, this.buildCssFetcher(), time, this.config.lockTime, this.config.proxyBase);
```

---

## Data Flow

```
HTML page response
  └─ rewriteHtmlUrls()          ← existing; rewrites <link href> to proxy URLs
       └─ inlineCssLinks()      ← new
            ├─ parse5 parse
            ├─ for each <link rel="stylesheet">:
            │    ├─ href: strip proxyBase origin if href.startsWith(proxyBase)
            │    │         → match RE_WAYBACK_PATH → {cssUrl, ts}
            │    │         → no match → leave <link> intact, continue
            │    ├─ fetchCss(cssUrl, ts)
            │    │    ├─ cache.lookup(cssUrl, ts)
            │    │    │    hit  → fs.readFile(hit.absPath) → CSS string
            │    │    │    miss → directClient.fetchAtRequestedTime(cssUrl, ts)
            │    │    │              outcome "ok"  → cache.writeFile(cssUrl, ts, body)
            │    │    │                            → cache.writeContentTypeSidecar(cssUrl, ts, "text/css")
            │    │    │                            → cache.writeResolvedTimeSidecar(ts, cssUrl, resolvedTime) [if returned]
            │    │    │                            → return body.toString("utf-8")
            │    │    │              outcome other → return null
            │    │    └─ any error → return null
            │    ├─ null  → leave <link> intact
            │    └─ string → rewriteCssUrls(css, cssUrl, ts, lockTime, undefined, undefined, proxyBase)
            │                 → create <style [media]> node
            │                 → replace <link> node
            └─ parse5 serialize → return HTML string
```

---

## Implementation Details

### Identifying stylesheet links

A `<link>` node qualifies when:
- `rel` attribute value, trimmed and lowercased, split on one-or-more whitespace characters, results in the array `["stylesheet"]` exactly — i.e. `"stylesheet"` is the only token. This correctly handles uppercase (`rel="STYLESHEET"`), surrounding whitespace (`rel="  stylesheet  "`), and rejects `rel="alternate stylesheet"`.
- Multi-token `rel` values that contain `"stylesheet"` alongside other tokens (e.g. `rel="stylesheet preload"`, `rel="alternate stylesheet"`) are **intentionally excluded** and left as-is. These indicate non-primary stylesheets or preload hints; inlining them would duplicate content and could break page intent.
- `href` attribute is a non-empty string.

### proxyBase href normalisation

```ts
const path = proxyBase && href.startsWith(proxyBase) ? href.slice(proxyBase.length) : href;
const match = path.match(RE_WAYBACK_PATH);
if (!match) { /* leave <link> intact */ continue; }
```

Using `startsWith`/`slice` (not `String.replace`) avoids incorrect stripping when the `proxyBase` origin also appears within the target URL segment of the href.

### Media attribute preservation

If the `<link>` has a `media` attribute, copy it to `<style media="...">`.

### CSS URL rewriting inside inlined CSS

Pass fetched CSS through `rewriteCssUrls(css, cssUrl, ts, lockTime, undefined, undefined, proxyBase)`. `cssUrl` is the original (un-proxied) CSS URL extracted from the proxy href — the correct base for resolving relative `url()` references inside the CSS.

### `fetchCss` callback error contract

The callback must never throw. It catches all errors internally and returns `null`. This keeps `inlineCssLinks` simple — a `null` result always means "leave `<link>` intact."

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| CSS not in cache, `directClient` available | Direct-fetch, write file + contentType + resolvedTime sidecars, inline |
| CSS not in cache, no `directClient` | Return `null` → keep `<link>` |
| Network/archive error during direct fetch | Catch, return `null` → keep `<link>` |
| `directClient.fetchAtRequestedTime` returns `outcome !== "ok"` | Return `null` → keep `<link>` |
| `href` not a valid proxy-format URL after proxyBase strip | Leave `<link>` intact (no fetch attempted) |
| `rel="alternate stylesheet"` | Not matched — left as-is |
| Malformed CSS content | `rewriteCssUrls` is defensive; passes through unchanged |
| No worker fallback for CSS | Intentional — blocking the page response on a BullMQ job for a secondary resource is not acceptable |

---

## Testing

### 1. `inlineCssLinks` unit tests

File: `tests/lib/url-rewriter.inline-css.test.ts`

| Case | What to assert |
|---|---|
| Single stylesheet, `fetchCss` returns CSS | `<link>` replaced by `<style>` with correct content |
| CSS contains `url()` references | Those URLs are rewritten to proxy format in the output |
| `media` attribute present | `<style media="...">` carries it through |
| `fetchCss` returns `null` | `<link>` left intact |
| Multiple stylesheets | Each handled independently |
| `rel="alternate stylesheet"` | Not replaced (multi-token `rel` intentionally excluded) |
| `rel="stylesheet preload"` | Not replaced (multi-token `rel` intentionally excluded) |
| Non-stylesheet `<link>` (favicon, canonical) | Untouched |
| `href` is absolute proxy URL (`proxyBase` set) | Origin stripped correctly via `startsWith`/`slice`; CSS resolved and inlined |
| `href` is not a proxy-format URL | `<link>` left intact, `fetchCss` not called |
| `rel` attribute value with surrounding whitespace | Trimmed and matched correctly |
| `rel="STYLESHEET"` (uppercase) | Matched and inlined |

### 2. `ProxyService` integration test

Use argument-matching stubs for `cache.lookup`:
- When called with `(htmlUrl, time)` → return a pre-built `CacheHit` (so Tier 2/3 is bypassed)
- When called with `(cssUrl, ts)` → return `null` (cache miss)

Stub `directClient.fetchAtRequestedTime(cssUrl, ts)` → `{ outcome: "ok", body: Buffer.from("body { color: red; }"), contentType: "text/css" }`. (No `resolvedTime` in this stub — the `writeResolvedTimeSidecar` branch is therefore not exercised in this test; add a separate test case if `resolvedTime` coverage is desired, stubbing the response with a `resolvedTime` value and asserting `cache.writeResolvedTimeSidecar(ts, cssUrl, resolvedTime)` was called.)

Assert:
- Response body contains `<style>body { color: red; }</style>` (or with rewritten content)
- Response body does not contain `<link rel="stylesheet">`
- `cache.writeFile` was called with `(cssUrl, ts, …)`
- `cache.writeContentTypeSidecar` was called with `(cssUrl, ts, "text/css")`
- `cache.writeResolvedTimeSidecar` was **not** called (stub returned no `resolvedTime`)

### 3. Regression

Run existing `rewriteHtmlUrls` tests unchanged. Confirm function signature and return type are unaffected.

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/url-rewriter.ts` | Add `inlineCssLinks` export |
| `src/services/proxy.ts` | Call `inlineCssLinks` after `rewriteHtmlUrls`; add private `buildCssFetcher` method |
| `tests/lib/url-rewriter.inline-css.test.ts` | New unit tests for `inlineCssLinks` |
| `tests/services/proxy.test.ts` | New integration test |
