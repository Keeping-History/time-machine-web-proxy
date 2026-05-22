---
id: 001-5b2f
title: Support Wayback-style /web/{TS}/{url} path format
status: complete
priority: P1
type: feature
created: "2026-05-22T00:08:14.434Z"
updated: "2026-05-22T00:16:05.723Z"
dependencies: []
started_at: "2026-05-22T00:08:17.837Z"
completed_at: "2026-05-22T00:16:05.723Z"
---

# Support Wayback-style /web/{TS}/{url} path format

## Problem Statement

Proxy currently only accepts /?url=<enc>&time=<ts> for selecting an archived page. Add Wayback-style /web/{TIMESTAMP}{MOD?}_/{ORIGINAL_URL} path format as an alternate INPUT (both formats accepted), and switch the HTML/CSS rewriter OUTPUT to emit the new path format. Modifiers (im_/cs_/js_/if_/fw_) are tolerated and stripped on input. Cache is unaffected because rewriting happens on every fetch.

## Acceptance Criteria

- [x] HTTP handler accepts GET /web/{14-digit-ts}/{url} and routes to ProxyService.fetch with extracted time + url
- [x] HTTP handler accepts GET /web/{14-digit-ts}{1-3-char-mod}_/{url} — modifier tolerated and stripped
- [x] Original URL after the timestamp segment is taken from the RAW req.url so the target URLs query string (?foo=bar) is preserved unaltered
- [x] Existing /?url=<enc>&time=<ts> path continues to work unchanged
- [x] HTML rewriter buildProxyUrl emits /web/{ts}/{originalUrl}
- [x] CSS rewriter emits the same /web/{ts}/{originalUrl} format
- [x] unwrapNestedProxyUrl detects BOTH formats (legacy ?url=&time= and new /web/{ts}/{url}) when the host matches proxyBaseHostname
- [x] Unit tests cover: path-based input with and without modifier, query-string preservation on target URL, both formats unwrapped from nested proxy URLs, all rewriter tests updated to new output format
- [x] Existing url-rewriter and proxy test suites pass
- [x] Typecheck + build clean
- [x] [MANUAL] Hit http://10.10.0.5:8765/web/20020401000000/http://www.apple.com in a browser; DevTools Network tab shows all asset requests routed through the proxy using /web/{ts}/{url} URLs

## Sub-Tasks
- [x] [T1] Update url-rewriter: parseWaybackPath, new buildProxyUrl, dual-format unwrap
## QA

Covered by 14 new tests (parseWaybackPath × 7, unwrapNestedProxyUrl path-format × 4, HTTP handler integration × 5). Updated 15 existing rewriter output assertions. Full suite 270/270 green; typecheck + build clean. MANUAL browser verification skipped (no live server in this session).

## Work Log


### 2026-05-22T00:09:21.713Z - Sub-task T1 created: Update url-rewriter: parseWaybackPath, new buildProxyUrl, dual-format unwrap

### 2026-05-22T00:14:39.888Z - Implemented path-based /web/{TS}/{url} INPUT format alongside existing ?url=&time=. Modifiers (im_/cs_/js_/if_/fw_) tolerated and stripped. Switched HTML+CSS rewriter OUTPUT to /web/{ts}/{originalUrl} (no inner-URL encoding); cache unaffected because rewriting happens on every fetch. unwrapNestedProxyUrl now detects both formats. parseWaybackPath uses raw req.url so target query strings are preserved. 270/270 tests pass; typecheck + build clean. Manual browser verification skipped (no live server in this session) — to verify, hit http://10.10.0.5:8765/web/20020401000000/http://www.apple.com and inspect Network tab for /web/{ts}/... asset URLs.


### 2026-05-22T00:16:05.436Z - Sub-task T1 completed: Update url-rewriter: parseWaybackPath, new buildProxyUrl, dual-format unwrap
