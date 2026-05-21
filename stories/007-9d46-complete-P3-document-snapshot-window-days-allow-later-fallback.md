---
id: 007-9d46
title: Document SNAPSHOT_WINDOW_DAYS, ALLOW_LATER_FALLBACK, and on-or-before semantics
status: complete
priority: P3
type: chore
created: "2026-05-21T22:26:59.509Z"
updated: "2026-05-21T22:45:18.759Z"
dependencies: ["005-a8ed", "006-15f9"]
plan: plans/snapshot-timestamp-resolver.md
plan_step: Step 7
started_at: "2026-05-21T22:44:23.304Z"
completed_at: "2026-05-21T22:45:18.758Z"
---

# Document SNAPSHOT_WINDOW_DAYS, ALLOW_LATER_FALLBACK, and on-or-before semantics

## Problem Statement

Two new operator-configurable env vars and a behavior change (on-or-before time semantic, negative caching) need to be documented in .env.example and README so operators know what to expect.

## Acceptance Criteria

- [x] SNAPSHOT_WINDOW_DAYS documented in .env.example with default value 30,365,3650,0 and a one-line description
- [x] ALLOW_LATER_FALLBACK documented in .env.example with default false and a one-line description
- [x] README explains the on-or-before semantic
- [x] README explains negative caching

## Files

- .env.example
- README.md

## QA

None — docs verified via grep

## Work Log

### 2026-05-21T22:45:17.887Z - Documented SNAPSHOT_WINDOW_DAYS and ALLOW_LATER_FALLBACK in .env.example (with inline explanation comments) and in README.md Environment Variables table. Added a new Snapshot resolution + Negative caching block in the HTTP API section explaining the on-or-before semantic, X-Archive-Time deviation from requested time, sentinel storage layout, and clearing via DELETE /cache.

