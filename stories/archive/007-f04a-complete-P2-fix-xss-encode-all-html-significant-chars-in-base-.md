---
id: 007-f04a
title: "Fix XSS: encode all HTML-significant chars in base href injection"
status: complete
priority: P2
created: "2026-05-20T01:52:36.898Z"
updated: "2026-05-20T02:18:11.833Z"
dependencies: []
---

# Fix XSS: encode all HTML-significant chars in base href injection

## Problem Statement

timemachine.ts:505 — stripWaybackToolbar only encodes double-quotes when injecting the base href attribute: baseUrl.replace(/"/g, "%22"). A URL containing single-quote, < or > in its path can break out of the attribute value and inject arbitrary HTML into every page served from that URL.

## Acceptance Criteria

- [ ] Encode & -> %26 before other replacements
- [ ] Encode single-quote -> %27
- [ ] Encode < -> %3C
- [ ] Encode > -> %3E
- [ ] Encode double-quote -> %22 (already present, keep it)
- [ ] Add unit test: URL with these chars produces safe base href attribute

## Work Log

### 2026-05-20T02:18:11.681Z - Encoded &, ', <, > in addition to " in stripWaybackToolbar base href injection

