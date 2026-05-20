---
id: "026-6fcc"
title: "Step 6: src/lib/url-validator.ts and src/lib/errors.ts"
status: pending
priority: P2
type: feature
created: 2026-05-20T03:19:21.073Z
updated: 2026-05-20T03:19:21.073Z
dependencies: []
plan: "plans/modular-refactor-pnpm-turborepo.md"
plan_step: "Step 6"
---

# Step 6: src/lib/url-validator.ts and src/lib/errors.ts

## Problem Statement

Extract URL validation functions and shared error utilities into their own modules

## Acceptance Criteria

- [ ] Create src/lib/url-validator.ts with validateTargetUrl, isHostWhitelisted(url, whitelistHosts), parseWhitelist — parameterize whitelistHosts
- [ ] Create src/lib/errors.ts with hasStatus type guard (shared — used by both HTTP and WS handlers)
- [ ] Write tests/lib/url-validator.test.ts: valid URLs, invalid protocol, private IP ranges, wildcard whitelist, pattern whitelist, invalid URL strings
- [ ] Tests green

## Work Log

