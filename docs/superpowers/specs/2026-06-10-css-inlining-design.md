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

---

## Architecture

### New function: `inlineCssLinks`

Location: `src/lib/url-rewriter.ts`

```ts
export async function inlineCssLinks(
  html: string,
  fetchCss: (proxyHref: string) => Promise<string | null>,
  targetUrl: string,
  time: string,
  lockTime: boolean,
  proxyBase: string,
): Promise<string>
```

Called by `ProxyService.fetchCore` immediately after `rewriteHtmlUrls`. The `fetchCss` callback is a closure over `ProxyService`'s `cache` and `directClient`.

### Call site change in `ProxyService.fetchCore`

Current (abbreviated):
```ts
const { html, discoveredAssets } = rewriteHtmlUrls(stripped, targetUrl, time, ...);
body = html;
```

After:
```ts
const { html, discoveredAssets } = rewriteHtmlUrls(stripped, targetUrl, time, ...);
body = await inlineCssLinks(html, makeCssFetcher(this), targetUrl, time, ...);
```

`makeCssFetcher` is a private method that returns the async callback.

---

## Data Flow

```
HTML page response
  └─ rewriteHtmlUrls()          ← existing; rewrites <link href> to proxy URLs
       └─ inlineCssLinks()      ← new
            ├─ parse5 parse
            ├─ for each <link rel="stylesheet">:
            │    ├─ fetchCss(proxyHref)
            │    │    ├─ parse proxyHref with RE_WAYBACK_PATH → {cssUrl, ts}
            │    │    ├─ cache.lookup(cssUrl, ts)
            │    │    │    hit  → read file → return CSS string
            │    │    │    miss → directClient.fetchAtRequestedTime(cssUrl, ts)
            │    │    │              → write to cache → return CSS string
            │    │    └─ any error → return null
            │    ├─ null  → leave <link> intact
            │    └─ string → rewriteCssUrls(css, ...)
            │                 → create <style [media]> node
            │                 → replace <link> node
            └─ parse5 serialize → return HTML string
```

---

## Implementation Details

### Identifying stylesheet links

A `<link>` node qualifies when:
- `rel` attribute (lowercased, split on whitespace) contains `"stylesheet"` **and** its only rel value is `"stylesheet"` (skip `rel="alternate stylesheet"`)
- `href` attribute is a non-empty string matching the proxy path format

### Media attribute preservation

If the `<link>` has a `media` attribute, copy it to `<style media="...">`.

### CSS URL rewriting inside inlined CSS

After fetching the CSS content, pass it through the existing `rewriteCssUrls(css, cssUrl, ts, lockTime, undefined, undefined, proxyBase)` before inserting it into the `<style>` block. This ensures `url()` references (images, fonts) inside the inlined CSS point at the proxy.

### `fetchCss` closure error contract

The callback must never throw. It catches all errors internally and returns `null`. This keeps `inlineCssLinks` simple — a `null` result always means "leave `<link>` intact."

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| CSS not in cache, `directClient` available | Fetch live, write to cache, inline |
| CSS not in cache, no `directClient` | Return `null` → keep `<link>` |
| Network/archive error during fetch | Catch, return `null` → keep `<link>` |
| `directClient.fetchAtRequestedTime` returns `outcome !== "ok"` | Return `null` → keep `<link>` |
| `rel="alternate stylesheet"` | Not matched — left as-is |
| Malformed CSS content | `rewriteCssUrls` is defensive; passes through unchanged |

---

## Testing

### 1. `inlineCssLinks` unit tests

File: `tests/lib/url-rewriter.inline-css.test.ts` (or appended to existing url-rewriter tests)

| Case | What to assert |
|---|---|
| Single stylesheet, fetchCss returns CSS | `<link>` replaced by `<style>` with correct content |
| CSS contains `url()` references | Those URLs are rewritten to proxy format in the output |
| `media` attribute present | `<style media="...">` carries it through |
| `fetchCss` returns `null` | `<link>` left intact |
| Multiple stylesheets | Each handled independently |
| `rel="alternate stylesheet"` | Not replaced |
| Non-stylesheet `<link>` (favicon, canonical) | Untouched |

### 2. `ProxyService` integration test

Stub `cache.lookup` (miss) and `directClient.fetchAtRequestedTime` (returns CSS body). Assert the HTML response body contains a `<style>` block and no `<link rel="stylesheet">`.

### 3. Regression

Run existing `rewriteHtmlUrls` tests unchanged. Confirm function signature and return type are unaffected.

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/url-rewriter.ts` | Add `inlineCssLinks` export |
| `src/services/proxy.ts` | Call `inlineCssLinks` after `rewriteHtmlUrls`; add private `fetchCss` method |
| `tests/lib/url-rewriter.*.test.ts` | New unit tests for `inlineCssLinks` |
| `tests/services/proxy.test.ts` | New integration test |
