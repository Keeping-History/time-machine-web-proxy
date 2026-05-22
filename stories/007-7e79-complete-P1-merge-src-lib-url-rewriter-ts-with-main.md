---
id: 007-7e79
title: Merge src/lib/url-rewriter.ts with main
status: complete
priority: P1
type: refactor
created: "2026-05-22T00:21:47.765Z"
updated: "2026-05-22T01:00:19.571Z"
dependencies: ["003-5bdf"]
started_at: "2026-05-22T00:57:54.525Z"
completed_at: "2026-05-22T01:00:19.570Z"
---

# Merge src/lib/url-rewriter.ts with main

## Problem Statement

Parallel reimplementations, not a stale-vs-current case. Main (35d5262, 280 lines) exports `rewriteHtmlUrls`, `toProxyUrl`, `URL_ATTRS_BY_TAG` (Map). Branch (a88c5d6, 190 lines) exports `parseWaybackPath`, `rewriteOneUrl`, `TAG_URL_ATTRS` (Record). Different API surfaces — picking one breaks the other side's callers. Boss must choose the canonical implementation.

## Acceptance Criteria

- [x] Both implementations diffed and behaviors compared with Boss; canonical implementation chosen
- [x] If main wins: branch's path-based handling (parseWaybackPath) ported on top or explicitly dropped with rationale
- [x] If branch wins: main's wayback-prefix handling / sanitizeTimeParam / unwrapNestedProxyUrl behaviors ported or kept
- [x] Public API surface used by src/services/proxy.ts updated to match the chosen implementation
- [REJECTED] tests/lib/url-rewriter.test.ts merge story completed and passing (Forward-reference to story #013-efe4 (tests/lib/url-rewriter.test.ts merge). Test conformance verified when 013 executes.)
- [REJECTED] No regression in toolbar-stripping or URL rewriting on a manual proxy fetch ([MANUAL] Manual proxy fetch required — covered by post-deploy verification.)

## Files

- src/lib/url-rewriter.ts

## Related

- src/services/proxy.ts merge
- tests/lib/url-rewriter.test.ts merge
- package.json merge

## QA

- [ ] [MANUAL] Smoke: fetch an archived page via the proxy; confirm rewritten <a href>, <img srcset>, <style>, <base>-honored relative URLs, and <meta http-equiv=refresh> all point at /web/<ts>/<url> on the proxy origin.

## Work Log

### 2026-05-22T01:00:18.344Z - Kept branch's path-based URL format + parse5 + parseWaybackPath + dual-format unwrapNestedProxyUrl. Ported main's coverage on top: (1) broader RE_SKIP_PREFIX (added sms, file, ftp, geo, ws, wss, magnet, view-source, chrome, safari-extension); (2) broader TAG_URL_ATTRS (added blockquote/q/del/ins cite, html manifest, body/table/td/th/tr background, longdesc on img/iframe/frame, frame tag); (3) <base href> handling — honors as effective base then strips the tag (consumeBaseTag); (4) meta-refresh content rewriting (rewriteMetaRefresh, META_REFRESH_RE); (5) post-resolve http/https protocol filter in rewriteOneUrl. Single canonical rewriteHtmlUrls API (html, targetUrl, time) — path-based output (proxyBase not needed since /web/<ts>/<url> is relative).

