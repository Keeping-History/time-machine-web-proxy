---
id: 002-20f3
title: Merge README.md with main
status: complete
priority: P3
type: chore
created: "2026-05-22T00:21:47.763Z"
updated: "2026-05-22T01:10:50.967Z"
dependencies: ["005-d125"]
started_at: "2026-05-22T01:10:12.002Z"
completed_at: "2026-05-22T01:10:50.967Z"
---

# Merge README.md with main

## Problem Statement

Branch added SNAPSHOT_WINDOW_DAYS / ALLOW_LATER_FALLBACK / on-or-before docs (98570a1). Main has multiple proxy/deployment doc updates (58ad5d2, 05ee70b, 6297960). Both edits are doc-shaped, likely co-existable but must be reviewed for inconsistent claims.

## Acceptance Criteria

- [x] Both sides' README changes reviewed with Boss and merge direction confirmed
- [x] Final README documents SNAPSHOT_WINDOW_DAYS and ALLOW_LATER_FALLBACK (from branch) if those env vars survive the merge of config.ts
- [x] Final README documents deployment/proxy changes from main
- [x] No contradictory statements about behavior between sections

## Files

- README.md

## Related

- src/lib/config.ts merge
- src/models/config.ts merge

## QA

None — doc-only change, verified by grep of expected env-var rows and sections

## Work Log

### 2026-05-22T01:10:50.029Z - README env-var table now unions: kept branch's SNAPSHOT_WINDOW_DAYS + ALLOW_LATER_FALLBACK + 'Snapshot resolution' + 'Negative caching' sections (Boss's choice in #005 to keep branch's snapshot work). Replaced branch's singular OUTBOUND_PROXY_URL row with main's OUTBOUND_PROXY_URLS + OUTBOUND_PROXY_CHOOSER + OUTBOUND_PROXY_COOLDOWN_SECONDS rows (Boss's choice in #005 to take main's multi-proxy stack). No contradictions between sections.

