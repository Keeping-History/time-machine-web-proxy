---
id: 006-81ec
title: "Fix nested proxy unwrap: guard against null/empty inner url"
status: complete
priority: P2
created: "2026-05-20T01:52:30.386Z"
updated: "2026-05-20T02:06:13.418Z"
dependencies: []
---

# Fix nested proxy unwrap: guard against null/empty inner url

## Problem Statement

timemachine.ts:876 — searchParams.has(url) is true even when get(url) returns empty string. The assignment targetUrl = nested.searchParams.get(url) can set targetUrl to null or empty, silently losing the original URL. The \!targetUrl guard at line 884 catches it but returns 400 Missing url parameter instead of proxying the original outer URL as-is.

## Acceptance Criteria

- [ ] Only overwrite targetUrl if the unwrapped value is a non-empty string
- [ ] If inner url is empty/null, leave targetUrl unchanged (do not clobber it)
- [ ] Behavior: outer URL with empty ?url= on proxy hostname is proxied as the outer URL itself

## Work Log

### 2026-05-20T02:06:13.040Z - Implemented: unwrapNestedProxyUrl helper extracted, hoisted proxyBaseHostname to module scope, applied to both HTTP and WS handlers. Typecheck clean.

