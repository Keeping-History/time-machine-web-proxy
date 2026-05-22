# Proxy URL rewriting: prefer path-based over absolute

**Type:** decision
**Tags:** `#architecture`, `#preference`, `#proxy`, `#url-rewriting`

## Context

The Time Machine proxy fetches archived HTML from the Wayback Machine and serves it locally. URLs inside that HTML (images, links, stylesheets, scripts, iframes, etc.) must be rewritten so the browser routes them back through the proxy instead of leaking to the live origin or to `web.archive.org`.

Two viable rewriting strategies exist:

- **Absolute:** `http://<proxy-host>:<port>/?url=<encoded>&time=<t>` — bakes the proxy's hostname and port into the cached HTML
- **Path-based:** `/?url=<encoded>&time=<t>` — relies on the browser resolving against whatever host served the page

## Decision

Use **path-based** rewrites for all URLs the proxy injects into served HTML and CSS.

## Consequences

- HTML doesn't embed the proxy's hostname or port → survives reverse-proxy reconfiguration, Cloud Run cold-starts, and local-vs-prod environment swaps **without** re-fetching the archive.
- `PROXY_BASE_URL` env var is no longer required for URL rewriting. It may still be useful for log/diagnostic display or for absolute redirect responses, but the rewriter should not depend on it.
- Cached HTML on disk is portable across deployments — the same cached file works whether served from `localhost:8765`, `10.10.0.5:8765`, or a public Cloud Run URL.
- `<base href>` injection conflicts with this approach and must be removed. `<base href>` only sets scheme+host (and directory for document-relative URLs) — it cannot transform URLs to add query parameters, so it cannot route relative URLs through the proxy.

## Implementation notes

The HTML rewriter (`src/lib/url-rewriter.ts`) must handle every URL-bearing attribute, not just `<a href>`:

- `<a href>`, `<link href>`, `<form action>`
- `<img src>`, `<img srcset>`
- `<script src>`, `<iframe src>`
- `<source src>`, `<source srcset>`, `<video src>`, `<audio src>`
- Inline `style="… url(…) …"` and `<style>` blocks
- CSS `url(...)` references (already handled by `rewriteCssUrls`)

For each URL, resolve it to absolute against the original `targetUrl` (handles relatives), then wrap it as `/?url=<encoded>&time=<t>`.

URLs embedded in JavaScript (`fetch("/api/...")`, dynamic URL construction) cannot be statically rewritten. This is an accepted limitation for the "view archived page" use case.
