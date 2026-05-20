# Code Review: fix-nested-proxy-url-port-check
**Date:** 2026-05-19
**Reviewers:** Multi-Agent (security, performance, architecture, simplicity, silent-failure, typescript, test-quality)
**Target:** branch `fix-nested-proxy-url-port-check` — `timemachine.ts`
**Confidence Threshold:** 80

## Summary
- **P1 Critical Issues:** 6
- **P2 Important Issues:** 14
- **P3 Nice-to-Have:** 9

The diff is correct: hostname-based matching is the right fix for TLS-terminated Cloud Run deployments. However the fix is **incomplete** — the same unwrap logic was not applied to the WebSocket handler, leaving an asymmetry. A second genuine bug was also found in the diff: the inner `time` param is silently dropped when a nested proxy URL is unwrapped.

---

## P1 - Critical (Block Merge)

- [ ] **[BUG]** WS handler missing nested proxy URL unwrap (`timemachine.ts:1094`)
  - Confidence: 97 — flagged by 6/7 agents
  - Issue: HTTP handler (lines 872-882) unwraps nested proxy URLs before validation. WS handler goes directly to `validateTargetUrl(msg.url)`. A WS client sending `http://localhost:8765/?url=https://example.com` hits `PRIVATE_HOST_RE` and gets a 403. The entire branch name says this is the fix, yet the fix was only applied to one transport.
  - Fix: Extract the unwrap into a shared helper; call from both the HTTP handler and the WS message handler before `validateTargetUrl`.
  - Agents: architecture, simplicity, typescript, security, performance, test-quality

- [ ] **[ARCH]** HTTP handler duplicates `proxyFetch` inline instead of calling it (`timemachine.ts:912`)
  - Confidence: 99 — flagged by 5/7 agents
  - Issue: ~90 lines of archive-fetch / cache / rewrite logic exist both in `proxyFetch` (lines 661-778, used by WS) and inlined in the HTTP handler (lines 912-999). Any logic change must be made in two places. The WS nested-URL miss (above) is a direct product of this divergence.
  - Fix: HTTP handler calls `proxyFetch`, writes the `ProxyResult` to `res`. `sendCached` becomes unnecessary.
  - Agents: architecture, simplicity, typescript, silent-failure, performance

- [ ] **[AUTH]** `DELETE /cache` is unauthenticated when `CACHE_CLEAR_TOKEN` is unset (`timemachine.ts:842`)
  - Confidence: 98
  - Issue: `if (cacheClearToken) { ... }` — the entire auth block is skipped when the env var is empty (the default). Any unauthenticated caller can wipe the entire cache, forcing expensive re-fetches and triggering Wayback Machine rate limiting.
  - Fix: `if (!cacheClearToken) { res.writeHead(403).end("Cache management not enabled"); return; }`
  - Agents: architecture, security

- [ ] **[TEST]** Zero test infrastructure exists (`package.json`)
  - Confidence: 100
  - Issue: No test runner, no test files, no `test` script. Every security-critical function (`validateTargetUrl`, `sanitizeTimeParam`, `isHostWhitelisted`) and the entire URL-rewrite pipeline are completely untested.
  - Fix: Add `vitest` (zero-config, native ESM+TypeScript). Pure functions can be unit-tested without an HTTP server.
  - Agents: test-quality

- [ ] **[TS]** Non-null assertion on queue entry (`timemachine.ts:314`)
  - Confidence: 97
  - Issue: `this.queue.shift()!` — suppresses the type system. Replace with `const entry = this.queue.shift(); if (!entry) break;`
  - Agents: typescript

- [ ] **[TS]** Unsafe `as` cast on caught `unknown` in WS error handler (`timemachine.ts:1140`)
  - Confidence: 92
  - Issue: `(e as { status?: number }).status` — no runtime check. `e` could be anything. Use a type guard: `const hasStatus = (e: unknown): e is { status: number } => e !== null && typeof e === "object" && "status" in e && typeof (e as Record<string, unknown>).status === "number"`
  - Agents: typescript

---

## P2 - Important (Fix Before/After Merge)

- [ ] **[BUG]** Nested proxy unwrap silently drops inner `time` param (`timemachine.ts:877`)
  - Confidence: 90 — flagged by 3 agents
  - Issue: `rewriteArchiveLinks` encodes `time` into every rewritten link. When a nested proxy URL is unwrapped, only `url` is extracted; the inner `time` is discarded and the outer request's `time` is used instead. Following a link to a 1997 page while browsing a 2001 page could serve the wrong snapshot.
  - Fix: After extracting `targetUrl`, also extract `nested.searchParams.get("time")` and re-run through `sanitizeTimeParam` with a fallback to the outer `time`.
  - Agents: typescript, performance, test-quality

- [ ] **[BUG]** Nested proxy unwrap can set `targetUrl` to `null` or `""` (`timemachine.ts:876`)
  - Confidence: 95
  - Issue: `searchParams.has("url")` is true even when `get("url")` returns `""` (empty value). Assignment `targetUrl = nested.searchParams.get("url")` can assign null/empty, silently losing the original URL. The `!targetUrl` guard catches it, but with the wrong response ("Missing url parameter" instead of proxying as-is).
  - Fix: `const unwrapped = nested.searchParams.get("url"); if (unwrapped) { targetUrl = unwrapped; }`
  - Agents: typescript, test-quality, silent-failure

- [ ] **[PERF]** `new URL(proxyBase).hostname` called on every HTTP request (`timemachine.ts:875`)
  - Confidence: 98 — flagged by 4 agents
  - Issue: This is the code added in this diff. `proxyBase` is a module-level constant; parsing it to get `.hostname` on every request is wasteful and the broad `catch` around it swallows a misconfiguration error silently.
  - Fix: `const proxyBaseHostname = new URL(proxyBase).hostname;` at module scope (throws at startup if misconfigured — correct behavior).
  - Agents: architecture, silent-failure, security, performance

- [ ] **[PERF]** `parseWhitelist` re-parses a constant string on every request (`timemachine.ts:69`)
  - Confidence: 98
  - Issue: `isHostWhitelisted` calls `parseWhitelist(whitelistHosts)` and discards the result on every call. `whitelistHosts` never changes.
  - Fix: `const parsedWhitelist = parseWhitelist(whitelistHosts);` at module scope.
  - Agents: simplicity, performance

- [ ] **[SECURITY]** XSS via partial HTML escaping in `stripWaybackToolbar` (`timemachine.ts:505`)
  - Confidence: 88
  - Issue: `baseUrl.replace(/"/g, "%22")` — only double-quotes are escaped before injecting into `<base href="...">`. A URL containing `'`, `<`, or `>` (valid in URL paths) can break out of the attribute.
  - Fix: Also encode `'` → `%27`, `<` → `%3C`, `>` → `%3E`, `&` → `%26`.
  - Agents: security

- [ ] **[SECURITY]** IPv6 private ranges missing from `PRIVATE_HOST_RE` (`timemachine.ts:88`)
  - Confidence: 85
  - Issue: `fc00::/7` (ULA), `fe80::/10` (link-local), `::ffff:` (IPv4-mapped) are not blocked. `http://[fd12::1]/` passes validation. Node's `URL` parser returns `[fd12::1]` as `.hostname` for such URLs.
  - Fix: Extend regex or add explicit checks for IPv6 private ranges.
  - Agents: security, test-quality

- [ ] **[SILENT]** `fetchAndCacheImage` empty catch contradicts its own comment (`timemachine.ts:542`)
  - Confidence: 97
  - Issue: `} catch { return false; }` — no logging. The comment in `prefetchResources` says "errors already logged inside fetchAndCacheImage" — this is false. Every image prefetch failure is invisible in production.
  - Fix: `} catch (e) { console.warn("[TimeMachine] Failed to prefetch image", { url, time, error: ... }); return false; }`
  - Agents: silent-failure

- [ ] **[SILENT]** `handleCacheClear` swallows `readdir` error (`timemachine.ts:599`)
  - Confidence: 90
  - Issue: `fs.readdir` failure is caught, 500 returned, but the error itself is never logged. Critical for diagnosing GCS FUSE mount failures.
  - Fix: `console.error("[TimeMachine] Failed to read cache directory", { cacheDir, error: ... })` before returning 500.
  - Agents: silent-failure

- [ ] **[ARCH]** `sendCached` duplicates cache-hit branch of `proxyFetch` (`timemachine.ts:782`)
  - Confidence: 97
  - Issue: `sendCached` (lines 782-816) re-implements the same HTML/CSS/binary rewrite pipeline as `proxyFetch`'s cache-hit path (lines 667-696). Resolved automatically if HTTP handler is refactored to call `proxyFetch`.
  - Agents: architecture, simplicity

- [ ] **[PERF]** Double disk read per cached resource on HTML cache hits (`timemachine.ts:547`)
  - Confidence: 92
  - Issue: `getCachedResourceUrls` reads each resource's cache file; then `fetchAndCacheImage` reads it again as a guard. Two GCS FUSE reads per already-cached image, on every HTML cache hit.
  - Agents: performance

- [ ] **[PERF]** `ArchiveRequestQueue` has no maximum queue depth (`timemachine.ts:264`)
  - Confidence: 88
  - Issue: Under sustained load or Wayback Machine slowdowns, the queue grows without bound. Each entry holds a closure and pending promise — unbounded memory growth.
  - Fix: Add `maxQueueSize`; reject with 503 when exceeded.
  - Agents: performance

- [ ] **[PERF]** `handleCacheClear` loads all cache bodies into memory simultaneously (`timemachine.ts:612`)
  - Confidence: 90
  - Issue: `Promise.all` over the entire cache directory reads all full HTML/binary bodies into the heap at once. On a large GCS FUSE cache, this can exhaust memory.
  - Fix: Process in batches with a concurrency cap (e.g., 20 files at a time).
  - Agents: security, performance

- [ ] **[TS]** Unsafe `as` casts on `JSON.parse` results (`timemachine.ts:129,619,1054`)
  - Confidence: 88
  - Issue: `JSON.parse(data) as CacheEntry` and `JSON.parse(data) as WsRequest` — no runtime validation. Corrupt cache files or malformed WS messages proceed with potentially undefined fields. Adding zod conflicts with the "lean bundle" rule; lightweight structural checks are sufficient.
  - Agents: typescript

- [ ] **[SILENT]** WS handler does not log upstream errors server-side (`timemachine.ts:1137`)
  - Confidence: 85
  - Issue: WS errors are serialized to the client but never logged on the server. The HTTP handler logs `console.error("[TimeMachine] Upstream request failed:", e)`. Asymmetric observability makes production debugging harder.
  - Agents: silent-failure

---

## P3 - Nice-to-Have

- [ ] **[DEAD]** `_rewriteImageUrls` is never called — delete it (`timemachine.ts:425`)
  - Confidence: 100 — flagged by 5 agents
  - Fix: Delete lines 425-440. `rewriteImageUrlsFiltered` is the live implementation.

- [ ] **[DEAD]** `_time` parameter in `rewriteArchiveLinks` is unused (`timemachine.ts:411`)
  - Confidence: 98
  - Fix: Remove the `_time` param and update the 4 call sites.

- [ ] **[LOG]** `proxyBase` missing from startup configuration log (`timemachine.ts:44`)
  - Confidence: 80
  - Issue: `proxyBase` is the most operationally significant variable for diagnosing link-rewriting and nested-URL issues (as this branch demonstrates) yet is not in the startup log.
  - Fix: Add `proxyBase` to the `console.log` options block.

- [ ] **[SHUTDOWN]** `server.close()` can hang if WebSocket clients are connected (`timemachine.ts:1160`)
  - Confidence: 82
  - Issue: `wss.close()` stops accepting new connections but does not terminate existing ones. `server.close()` callback never fires while WS clients are alive.
  - Fix: Iterate `wss.clients` and call `ws.terminate()` before `server.close()`.

- [ ] **[STYLE]** Inconsistent indentation in HTTP handler (`timemachine.ts:797,944,973`)
  - Confidence: 92
  - Issue: Lines 944, 973, 797 have extra leading tabs vs surrounding code. Formatter artifact from copy-paste.

- [ ] **[TS]** `isRetryable` redundant cast after `instanceof` guard (`timemachine.ts:252`)
  - Confidence: 82
  - Fix: Remove the redundant `as Error &` prefix; `err` is already narrowed to `Error` after the guard.

- [ ] **[TS]** `hostname` module-level variable shadowed inside `handleCacheClear` (`timemachine.ts:627`)
  - Confidence: 80
  - Fix: Rename inner binding to `entryHostname`.

- [ ] **[SILENT]** `isHostWhitelisted` returns `false` on URL parse failure — misleading 403 (`timemachine.ts:80`)
  - Confidence: 80
  - Issue: If a malformed URL reaches `isHostWhitelisted` before `validateTargetUrl`, the user gets "Host not whitelisted" instead of "Invalid URL". Low risk given current call order but misleading.

- [ ] **[PERF]** HTML scanned by resource regexes twice per uncached response (`timemachine.ts:455,558`)
  - Confidence: 80
  - Issue: `collectWaybackResourceUrls` scans with 4 regex passes; then `rewriteImageUrlsFiltered` and `rewriteCssUrlsFiltered` scan with the same patterns. Two passes over large archive pages.

---

## Cross-Cutting Analysis

### Root Causes

| Root Cause | Findings Affected | Fix |
|------------|-------------------|-----|
| HTTP handler bypasses `proxyFetch` | WS missing unwrap, sendCached duplication, logic drift | HTTP handler calls `proxyFetch` + writes result to `res` |
| Per-request parsing of module constants | `new URL(proxyBase)` per-request, `parseWhitelist` per-request | Hoist both to module scope |
| Incomplete fix on this branch | WS missing unwrap, inner `time` dropped | Extract `unwrapNestedProxyUrl(url): string` helper |
| No test infrastructure | All test-quality findings | Add `vitest` |

### Single-Fix Opportunities

1. **Extract `unwrapNestedProxyUrl` + apply to WS** — Fixes WS missing unwrap (P1), inner-time dropped (P2), and naturally moves `new URL(proxyBase).hostname` to module scope (P2). ~15 lines.
2. **HTTP handler delegates to `proxyFetch`** — Fixes HTTP/proxyFetch duplication (P1), eliminates `sendCached` (P2 arch), reduces double-disk-read opportunity. ~90 lines removed.
3. **Add `vitest` + unit tests for pure functions** — Covers all test-quality P1/P2 gaps. Foundational; all other test findings depend on this.

### Context Files (Read Before Fixing)

| File | Reason |
|------|--------|
| `timemachine.ts:661-778` | `proxyFetch` — the shared abstraction the HTTP handler should delegate to |
| `timemachine.ts:872-882` | The nested URL unwrap that needs to become a shared helper |
| `timemachine.ts:504-511` | `stripWaybackToolbar` — the XSS-adjacent `base href` injection |

---

## Recommended Actions

1. **Before merging this branch:** Apply the nested URL unwrap to the WS handler (P1). Fix the inner `time` parameter being dropped (P2). Hoist `new URL(proxyBase).hostname` to module scope (P2).
2. **Follow-up PR:** Refactor HTTP handler to delegate to `proxyFetch`, eliminating the duplication. This also resolves the WS unwrap more cleanly.
3. **Separate track:** Add vitest + unit tests for `validateTargetUrl`, `sanitizeTimeParam`, `isHostWhitelisted`, and the URL rewrite functions.
4. **Security hardening:** Fix `DELETE /cache` auth bypass (P1), `base href` partial escaping (P2), IPv6 private range gaps (P2).
