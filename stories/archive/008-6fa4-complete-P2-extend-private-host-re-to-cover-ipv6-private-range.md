---
id: 008-6fa4
title: Extend PRIVATE_HOST_RE to cover IPv6 private ranges
status: complete
priority: P2
created: "2026-05-20T01:52:47.232Z"
updated: "2026-05-20T02:18:12.168Z"
dependencies: []
---

# Extend PRIVATE_HOST_RE to cover IPv6 private ranges

## Problem Statement

timemachine.ts:88 — PRIVATE_HOST_RE does not block IPv6 ULA (fc00::/7), link-local (fe80::/10), or IPv4-mapped (::ffff:) addresses. A URL like http://[fd12::1]/ passes validateTargetUrl. Node URL parser returns [fd12::1] as .hostname for such URLs.

## Acceptance Criteria

- [ ] Block fc00:: through fdff:: (ULA range, starts with fc or fd)
- [ ] Block fe80:: through febf:: (link-local, starts with fe8, fe9, fea, feb)
- [ ] Block ::ffff: prefix (IPv4-mapped)
- [ ] Existing IPv4 private ranges unchanged
- [ ] Add unit tests for at least [fd12::1], [fe80::1], [::ffff:127.0.0.1]

## Work Log

### 2026-05-20T02:18:12.015Z - Extended PRIVATE_HOST_RE with IPv6 ULA (fc/fd), link-local (fe8x-febx), and IPv4-mapped (::ffff:)

