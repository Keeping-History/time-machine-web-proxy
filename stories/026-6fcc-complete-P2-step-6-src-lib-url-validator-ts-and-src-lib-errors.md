---
id: 026-6fcc
title: "Step 6: src/lib/url-validator.ts and src/lib/errors.ts"
status: complete
priority: P2
type: feature
created: "2026-05-20T03:19:21.073Z"
updated: "2026-05-20T14:45:19.597Z"
dependencies: []
plan: plans/modular-refactor-pnpm-turborepo.md
plan_step: Step 6
started_at: "2026-05-20T14:44:20.310Z"
completed_at: "2026-05-20T14:45:19.597Z"
---

# Step 6: src/lib/url-validator.ts and src/lib/errors.ts

## Problem Statement

Extract URL validation functions and shared error utilities into their own modules

## Acceptance Criteria

- [x] Create src/lib/url-validator.ts with validateTargetUrl, isHostWhitelisted(url, whitelistHosts), parseWhitelist — parameterize whitelistHosts
- [x] Create src/lib/errors.ts with hasStatus type guard
- [x] Write tests/lib/url-validator.test.ts: valid URLs, invalid protocol, private IP ranges, wildcard whitelist, pattern whitelist, invalid URL strings
- [x] Tests green

## QA

None

## Work Log

### 2026-05-20T14:45:19.412Z - Extracted validateTargetUrl, isHostWhitelisted (parameterized), parseWhitelist to src/lib/url-validator.ts; extracted hasStatus to src/lib/errors.ts; 25 tests all green

