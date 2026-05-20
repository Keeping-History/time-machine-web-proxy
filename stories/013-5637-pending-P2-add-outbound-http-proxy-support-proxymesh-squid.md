---
id: "013-5637"
title: "Add outbound HTTP proxy support (ProxyMesh / Squid)"
status: pending
priority: P2
type: feature
created: 2026-05-20T17:11:02.518Z
updated: 2026-05-20T17:11:02.518Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 12"
---

# Add outbound HTTP proxy support (ProxyMesh / Squid)

## Problem Statement

wayback-machine-downloader uses native fetch internally. To route Wayback requests through an outbound proxy (ProxyMesh or Squid), undici.setGlobalDispatcher must be called before any fetch.

## Acceptance Criteria

- [ ] src/lib/outbound-proxy.ts exports installOutboundProxy
- [ ] installOutboundProxy called in src/index.ts before new Dependencies(config)
- [ ] When OUTBOUND_PROXY_URL set, setGlobalDispatcher called once with ProxyAgent whose uri includes basic-auth credentials URL-encoded
- [ ] When OUTBOUND_PROXY_URL unset, setGlobalDispatcher NOT called
- [ ] When only one of USERNAME/PASSWORD set, startup throws with clear message
- [ ] OUTBOUND_PROXY_URL validated as parseable http:// or https:// URL at startup
- [ ] Password never logged; auth indicator shows basic or ip
- [ ] tests/lib/outbound-proxy.test.ts passes all scenarios

## Work Log

