# Server-side meta-refresh following — design

**Date:** 2026-07-21
**Status:** Approved (design)

## Problem

Many archived pages are *redirect stubs*: their only meaningful content is a
`<meta http-equiv="refresh" content="0;url=X">` tag that a real browser would
act on to navigate to `X`. The proxy already **parses and URL-rewrites** that
tag (`rewriteMetaRefresh` in `src/lib/url-rewriter.ts`), but then leaves it
inert in the served HTML.

The primary consumer — the rt911 **Browser** app — is not a real browser. It
fetches the proxy's HTML (over HTTP `fetch()` or WebSocket) and renders it into
a **shadow DOM**, intercepting link clicks and re-driving them through the
proxy. A `<meta http-equiv="refresh">` inside `innerHTML`/shadow content
**never fires**. Result: redirect-stub pages render as blank dead-ends, and
even in a real browser the user waits out the refresh delay.

## Goal

When a fetched archived page is a meta-refresh redirect, the proxy resolves the
redirect chain **server-side** and returns the *destination's* content in the
same response. The client never sees an inert stub and never waits on a
timeout. Any refresh delay `N` is treated as immediate.

Chosen mechanism (over emitting an HTTP 302 / WS redirect frame): **transparent
server-side follow** — uniform across the HTTP, SSE, and WS transports, and
requires **no** change to the rt911 client.

## Security boundary (drives the architecture)

`ProxyService.fetch` deliberately does **not** enforce SSRF/whitelist policy —
see the comment at `src/services/proxy.ts` (§ "SSRF policy is NOT enforced
here"). Validation (`validateTargetUrl` + `isHostWhitelisted`) happens in the
HTTP/WS handlers in `src/services/time-machine.ts` **before** a URL reaches the
proxy.

A meta-refresh target comes from **page content** and is therefore untrusted. A
stub could point at an internal address (`http://169.254.169.254/…`) or a
non-whitelisted host. Therefore the **follow loop must live in the handler**,
where re-validation already exists — **not** inside `ProxyService`. The proxy
only *reports* the redirect; the handler owns the bounded, re-validating
follow.

## Design

### 1. Capture — `src/lib/url-rewriter.ts`

- New exported pure helper:
  `resolveMetaRefreshTarget(content, targetUrl, fallbackTime): { url: string; time: string } | null`.
  Mirrors `rewriteOneUrl`'s resolution but returns the **original** (un-proxied)
  absolute URL + timestamp:
  - Wayback-wrapped target (`RE_ARCHIVE_URL`) → `{ url: originalUrl, time: ts if 14-digit else fallbackTime }`.
  - Relative/absolute origin URL → `unwrapRedirectUrl` + `new URL(unwrapped, targetUrl)`; http/https only → `{ url: resolved, time: fallbackTime }`.
  - No `url=` (self-reload, e.g. `content="30"`), or a non-http scheme
    (`data:`, `javascript:`, …) → `null`. These are not navigations.
- `visit()` records the **first** meta-refresh target into a new mutable
  accumulator (same pattern as the existing `collect`/`assets` accumulators).
  `rewriteHtmlUrlsToAst` (and `rewriteHtmlUrls`) return it as a new field
  `metaRefresh?: { url: string; time: string }`. Single parse, no extra pass.

### 2. Report — `src/models/proxy.ts` + `src/services/proxy.ts`

- `ProxyResult` gains `redirect?: { url: string; time: string }` — the original
  destination URL + timestamp.
- `fetchCore`, on the HTML branch: when `metaRefresh` is captured, it **still
  fully rewrites** the stub (so it remains a valid fallback body) but **skips
  prewarm and domain-crawl**, and sets `result.redirect`. No recursion here —
  the SSRF boundary is preserved.

### 3. Follow — `src/services/time-machine.ts`

- New module-level helper:
  `resolveFollowingRedirects(deps, url, time, onProgress?): Promise<ProxyResult>`.
  - Calls `deps.proxy.fetch(url, time, onProgress)`.
  - While the result carries `redirect`: re-run `deps.validator.validateTargetUrl`
    + `deps.validator.isHostWhitelisted` on the destination, then re-fetch.
  - **Guards:**
    - `MAX_REDIRECT_HOPS` (module constant, `5`).
    - A visited-set of normalized URLs — kills `A → B → A` loops and
      `content="0;url=<self>"` self-refresh.
    - Validation/whitelist failure, hop-limit, or revisit → **stop** and return
      the last fully-rewritten stub result (graceful degrade to today's
      behavior), logging a warning with the offending target.
- `httpHandler`, `sseHandler`, and `wsHandler` replace their direct
  `proxy.fetch(...)` call with `resolveFollowingRedirects(...)`. Uniform across
  all three transports.

## Decisions

- **No new env flag.** The behavior *is* the feature request; a kill-switch is
  sprawl. `MAX_REDIRECT_HOPS` is a hardcoded constant.
- **Non-whitelisted / invalid redirect target → serve the rewritten stub**
  (degrade to current behavior + warn), rather than erroring.
- **Address bar / history** on the rt911 client is unchanged by this work: the
  content is the destination's, but the client still shows the requested URL.
  Surfacing the resolved destination to the client (via `X-Original-Url` /
  WS `originalUrl`) is a possible follow-up, out of scope here.

## Testing (TDD)

- `resolveMetaRefreshTarget`: absolute, relative, Wayback-wrapped (+ts),
  quoted, no-`url=` → null, non-http scheme → null, delay value ignored.
- `rewriteHtmlUrlsToAst`: returns `metaRefresh` for a stub page; omits it for a
  normal page and for a self-reload.
- `ProxyService.fetchCore`: sets `result.redirect` on a meta-refresh HTML page;
  skips prewarm/crawl in that case.
- `resolveFollowingRedirects`: follows to the destination and returns its
  content; re-validates each hop; stops at `MAX_REDIRECT_HOPS`; stops on a
  revisit/self-loop; degrades to the stub (with a warning) on a non-whitelisted
  target.

## Rejected alternative

Put the follow loop **inside** `ProxyService` (inject the validator). Rejected:
it muddies the deliberate SSRF boundary and adds a validator dependency to the
proxy for no gain.
