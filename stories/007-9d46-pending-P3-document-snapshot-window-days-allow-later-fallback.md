---
id: 007-9d46
title: Document SNAPSHOT_WINDOW_DAYS, ALLOW_LATER_FALLBACK, and on-or-before semantics
status: pending
priority: P3
type: chore
created: "2026-05-21T22:26:59.509Z"
updated: "2026-05-21T22:27:07.407Z"
dependencies: ["005-a8ed", "006-15f9"]
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 7
---

# Document SNAPSHOT_WINDOW_DAYS, ALLOW_LATER_FALLBACK, and on-or-before semantics

## Problem Statement

Two new operator-configurable env vars and a behavior change (on-or-before time semantic, negative caching) need to be documented in .env.example and README so operators know what to expect.

## Acceptance Criteria

- [ ] SNAPSHOT_WINDOW_DAYS documented in .env.example with default value 30,365,3650,0 and a one-line description
- [ ] ALLOW_LATER_FALLBACK documented in .env.example with default false and a one-line description
- [ ] README explains the on-or-before semantic (proxy returns closest snapshot <= requested time)
- [ ] README explains negative caching (404s are cached on disk; cleared via DELETE /cache)

## Files

- .env.example
- README.md

## Work Log

