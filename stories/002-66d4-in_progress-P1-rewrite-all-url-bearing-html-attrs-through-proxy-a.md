---
id: 002-66d4
title: Rewrite all URL-bearing HTML attrs through proxy as path-based URLs
status: in_progress
priority: P1
type: fix
created: "2026-05-21T23:03:14.772Z"
updated: "2026-05-21T23:06:22.529Z"
dependencies: []
started_at: "2026-05-21T23:06:22.529Z"
---

# Rewrite all URL-bearing HTML attrs through proxy as path-based URLs

## Problem Statement

Proxy currently only rewrites <a href> archive.org URLs. Images, stylesheets, scripts, iframes, srcset, and form actions leak directly to the live origin or to web.archive.org, bypassing the proxy. Additionally, stripWaybackToolbar injects <base href="<targetUrl>">, which forces every relative URL in the page to resolve against the original origin (e.g., http://www.apple.com). Together these mean assets never flow through the proxy. Fix: remove <base href> injection; rewrite every URL-bearing attribute (resolved against targetUrl) as a path-based proxy URL (/?url=<encoded>&time=<t>) so HTML is portable across deployments and PROXY_BASE_URL is not baked in.

## Acceptance Criteria

- [ ] HTML rewriter handles all URL-bearing attrs: <a href>, <link href>, <form action>, <img src>, <img srcset>, <script src>, <iframe src>, <source src>, <source srcset>, <video src>, <audio src>, and inline style url(...)
- [ ] Archive URL matcher handles Wayback modifiers (im_, cs_, js_, if_, fw_) between timestamp and target URL — same pattern as existing RE_CSS_URL_ABSOLUTE
- [ ] All rewrites emit path-based URLs (/?url=<encoded>&time=<t>) — no scheme or host baked into output
- [ ] Relative URLs (path-absolute and document-relative) resolve against targetUrl before being wrapped
- [ ] <base href> injection removed from stripWaybackToolbar
- [ ] url-rewriter no longer references PROXY_BASE_URL or proxyBase for HTML/CSS output; proxyBase removed from rewriter signatures
- [ ] HTML parsing uses parse5 (or equivalent compliant parser) — regex approach replaced for HTML; CSS url() rewriting may remain regex-based
- [ ] Unit tests cover: <a>, <img>, <img srcset>, <link>, <script>, <iframe>, <source srcset>, path-absolute relative, document-relative, archive.org URL with im_ modifier, archive.org URL without modifier, inline style url(), and a no-rewrite case (data: URIs, mailto:, javascript:)
- [ ] tests/lib/url-rewriter.test.ts passes including the new cases
- [ ] [MANUAL] In browser at http://10.10.0.5:8765/?url=http://www.apple.com — DevTools Network tab shows all asset requests routed through 10.10.0.5:8765 (no requests to www.apple.com or web.archive.org)

## Files

- src/lib/url-rewriter.ts
- src/services/proxy.ts
- tests/lib/url-rewriter.test.ts
- package.json

## Work Log

