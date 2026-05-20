---
status: in_progress
approved_at: "2026-05-20T03:18:39.487Z"
updated: "2026-05-20T03:20:11.085Z"
started_at: "2026-05-20T03:20:11.085Z"
---
# Implementation Plan: Modular Refactor + pnpm + Turborepo

**Created:** 2026-05-20
**Status:** Draft
**Estimated Effort:** L

## Summary

Split the monolithic `timemachine.ts` (1159 lines) into a proper module tree under `src/`, organized by architectural role. Services and clients become injectable classes. Utilities are pure modules or classes depending on statefulness. The build system migrates from npm to pnpm, and Turborepo is added as the task orchestrator. The Dockerfile and `cloudbuild.yaml` are updated to match the new build layout. Add and enforce biome linting and formatting.

The refactor is purely structural — no logic changes. Every function, class, and interface that exists today survives the split; only their location changes. TDD is applied by writing tests for each module before or during extraction.

---

## Research Findings

### Current codebase structure (timemachine.ts, 1159 lines)

| Lines | Section | Contents |
|-------|---------|---------|
| 12–62 | Config | All `process.env` reads + startup log |
| 64–85 | Host whitelist | `parseWhitelist`, `isHostWhitelisted` |
| 87–107 | URL validation | `validateTargetUrl`, `ALLOWED_PROTOCOLS`, `PRIVATE_HOST_RE` |
| 109–161 | Cache I/O | `CacheEntry`, `cacheKey`, `cacheGet`, `cachePut` |
| 163–498 | URL rewriting | 10 regex constants, `sanitizeTimeParam`, `arcUrl`, `rewriteArchiveLinks`, `rewriteCssUrls`, `rewriteImageUrlsFiltered`, `rewriteCssUrlsFiltered`, `stripWaybackToolbar`, `collectWaybackResourceUrls` |
| 206–409 | Request queue | `ResourceType`, `BROWSER_HEADERS`, `ArchiveRequestQueue`, `fetchFromArchive`, `abortableSleep` |
| 500–550 | Prefetch | `fetchAndCacheImage`, `prefetchResources`, `getCachedResourceUrls` |
| 552–634 | Cache management | `handleCacheClear`, `domainMatcher`, `matchesTypeFilter` |
| 636–762 | Proxy fetch | `ProxyResult`, `proxyFetch` |
| 764–988 | HTTP server | `sendCached`, full HTTP handler |
| 991–1142 | WebSocket server | `WsRequest`, `WsResponse`, WebSocket handler |
| 1144–1158 | Lifecycle | `shutdown`, signal handlers, `server.listen` |

### Key dependencies between sections

```
Config ──► everything
ArchiveRequestQueue ──► WaybackClient (fetchFromArchive)
WaybackClient ──► CacheService (fetchAndCacheImage)
CacheService ──► ProxyService (proxyFetch)
UrlRewriter ──► ProxyService
UrlValidator ──► HTTP handler, WebSocket handler
ProxyService ──► TimeMachineService (HTTP + WS handlers)
CacheService ──► TimeMachineService (handleCacheClear, sendCached)
```

### Build system

- **Current:** npm + esbuild, entry point `timemachine.ts → dist/timemachine.js`
- **Target:** pnpm + Turborepo, entry point `src/index.ts → dist/timemachine.js`
- Turborepo in single-package mode (no `apps/` or `packages/` split needed now — that's a future concern)
- esbuild command remains essentially the same, just entry file changes
- Dockerfile `COPY timemachine.ts` → `COPY src/` + minor entrypoint tweak

### Best Practices

- **pnpm**: drop-in npm replacement; `pnpm-lock.yaml` replaces `package-lock.json`; Volta works with pnpm
- **Turborepo**: `turbo.json` defines pipeline tasks (`build`, `typecheck`, `test`); in single-package mode it just orchestrates local scripts efficiently with caching
- **Dependency injection**: constructor injection is preferred over singletons; module-level singletons are acceptable for config and the queue (one instance for the lifetime of the process)
- **Jest + ts-jest**: standard for Node/TypeScript unit tests; `@swc/jest` is faster but adds a build dependency; ts-jest is simpler for this project size

---

## Proposed File Layout

```
time-machine-web-proxy/
├── src/
│   ├── index.ts                         # Entry point: wire + start
│   ├── models/
│   │   ├── cache.ts                     # CacheEntry
│   │   ├── config.ts                    # Config
│   │   ├── proxy.ts                     # ProxyResult
│   │   ├── queue.ts                     # QueueEntry, ResourceType
│   │   └── websocket.ts                 # WsRequest, WsResponse
│   ├── lib/
│   │   ├── config.ts                    # Reads env vars, returns Config
│   │   ├── shutdown.ts                  # ShutdownController, abortableSleep
│   │   ├── queue.ts                     # ArchiveRequestQueue class
│   │   ├── url-validator.ts             # validateTargetUrl, isHostWhitelisted
│   │   └── url-rewriter.ts              # All regex constants + rewrite fns
│   ├── clients/
│   │   └── wayback.ts                   # WaybackClient class
│   └── services/
│       ├── cache.ts                     # CacheService class
│       ├── proxy.ts                     # ProxyService class
│       └── time-machine.ts              # TimeMachineService class
├── tests/
│   ├── lib/
│   │   ├── url-validator.test.ts
│   │   ├── url-rewriter.test.ts
│   │   └── queue.test.ts
│   ├── clients/
│   │   └── wayback.test.ts
│   └── services/
│       ├── cache.test.ts
│       └── proxy.test.ts
├── dist/
│   └── timemachine.js                   # esbuild output (unchanged name)
├── turbo.json
├── pnpm-workspace.yaml
├── package.json                         # updated: pnpm, turbo, jest
├── tsconfig.json                        # updated: include src/**/*
├── Dockerfile                           # updated: COPY src/ + pnpm
└── cloudbuild.yaml                      # updated: npm → pnpm
```

### Research Enhancement

- **Pattern — Missing files:** Add `src/lib/errors.ts` to layout (exports `hasStatus` and future error-narrowing utilities). Add `biome.json` at repo root.
- **Framework — Biome:** Add `biome.json` to root of file layout. No existing `.eslintrc*` or `.prettierrc*` to migrate — Biome added clean.
- **Ref:** repo-research-researcher (Gap 3), framework-docs-researcher (Gap 8)

---

## Module Responsibilities

### src/models/cache.ts
```typescript
export interface CacheEntry {
  contentType: string;
  archiveUrl: string;
  archiveTime: string;
  body: string;
  isHtml: boolean;
  isCss: boolean;
}
```

### src/models/config.ts
```typescript
export interface Config {
  port: number;
  hostname: string;
  defaultTime: string;
  archivePrefix: string;
  cacheDir: string;
  cacheEnabled: boolean;
  allowedOrigins: string[];
  archiveRatePerSec: number;
  archiveBurst: number;
  archiveMaxRetries: number;
  archiveMaxConcurrent: number;
  whitelistHosts: string;
  proxyPrefix: string;
  proxyBase: string;
  cacheClearToken: string;
  wsKeepaliveMs: number;
}
```

### src/models/proxy.ts
```typescript
export interface ProxyResult {
  contentType: string;
  archiveUrl: string;
  originalUrl: string;
  archiveTime: string;
  body: string | Buffer;
  cache: 'HIT' | 'MISS';
}
```

### src/models/queue.ts
```typescript
export type ResourceType = 'document' | 'image' | 'style';

export interface QueueEntry {
  execute: () => Promise<Response>;
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
}
```

### src/models/websocket.ts
```typescript
export interface WsRequest {
  type: 'fetch';
  id?: string;
  url: string;
  time?: string;
}
export interface WsResponse { ... }
```

### src/lib/config.ts
- Reads all `process.env` vars
- Returns a frozen `Config` object
- Handles defaults and type coercion (no logic, only env reads)
- Also ensures `cacheDir` exists (`mkdirSync`)

### src/lib/shutdown.ts
- Exports `ShutdownController` wrapping `AbortController`
- Exports `abortableSleep(ms, signal): Promise<void>`

### src/lib/queue.ts
- `ArchiveRequestQueue` class — unchanged from current implementation
- Constructor: `(maxConcurrent, ratePerSec, burst)`
- Methods: `enqueue`, `abort`
- Getters: `pending`, `running`

### src/lib/url-validator.ts
- Stateless module (no class needed)
- Exports: `validateTargetUrl(raw: string): string`, `isHostWhitelisted(url: string, whitelistHosts: string): boolean`, `parseWhitelist(raw: string): string[]`
- Note: `whitelistHosts` is passed as a parameter rather than closed over — makes testing easier

### src/lib/url-rewriter.ts
- Stateless module (no class needed)
- Exports all 10 regex constants
- Exports: `sanitizeTimeParam`, `arcUrl`, `rewriteArchiveLinks`, `rewriteCssUrls`, `rewriteImageUrlsFiltered`, `rewriteCssUrlsFiltered`, `collectWaybackResourceUrls`, `stripWaybackToolbar`
- `arcUrl` and `rewriteArchiveLinks`/`rewriteCssUrls` accept `proxyBase` and `prefix` as parameters (not closed over)

### src/clients/wayback.ts — WaybackClient class
```typescript
class WaybackClient {
  constructor(
    private readonly queue: ArchiveRequestQueue,
    private readonly config: Pick<Config, 'archivePrefix' | 'archiveMaxRetries'>
  ) {}

  async fetch(url: string, retries?: number, resourceType?: ResourceType): Promise<Response>
}
```
- Contains `BROWSER_HEADERS`, `BROWSER_UA`, `RETRYABLE_ERROR_CODES`, `isRetryable`
- Guards that URL starts with `archivePrefix`
- Delegates rate-limiting/concurrency to the injected queue
- Uses injected `ShutdownController.signal` for `abortableSleep`

### src/services/cache.ts — CacheService class
```typescript
class CacheService {
  constructor(private readonly config: Pick<Config, 'cacheDir' | 'cacheEnabled'>) {}

  async get(url: string, time: string): Promise<CacheEntry | null>
  async put(url: string, time: string, entry: CacheEntry): Promise<void>
  async handleCacheClear(req: IncomingMessage, res: ServerResponse): Promise<void>
  private key(url: string, time: string): string
}
```
- `domainMatcher` and `matchesTypeFilter` become private methods
- `RE_WAYBACK_EXTRACT_URL` becomes a module-level constant in this file

### src/services/proxy.ts — ProxyService class
```typescript
class ProxyService {
  constructor(
    private readonly cache: CacheService,
    private readonly wayback: WaybackClient,
    private readonly config: Pick<Config, 'proxyBase' | 'archivePrefix'>
  ) {}

  async fetch(targetUrl: string, time: string): Promise<ProxyResult>
  async sendCached(res: ServerResponse, entry: CacheEntry, targetUrl: string, time: string): Promise<void>
  async fetchAndCacheImage(url: string, time: string): Promise<boolean>
  prefetchResources(html: string, time: string): void
  async getCachedResourceUrls(html: string, time: string): Promise<Set<string>>
}
```

### src/services/time-machine.ts — TimeMachineService class
```typescript
class TimeMachineService {
  constructor(
    private readonly config: Config,
    private readonly proxy: ProxyService,
    private readonly cache: CacheService,
    private readonly validator: typeof import('../lib/url-validator'),
    private readonly shutdown: ShutdownController
  ) {}

  start(): void          // server.listen + wss setup
  stop(): Promise<void>  // graceful shutdown
}
```
- Creates `http.createServer` and `WebSocketServer` internally
- Owns CORS headers, method routing, WebSocket keepalive logic
- Registers `SIGTERM`/`SIGINT` handlers

### src/index.ts — Entry point
```typescript
const config = loadConfig();
const shutdown = new ShutdownController();
const queue = new ArchiveRequestQueue(config.archiveMaxConcurrent, config.archiveRatePerSec, config.archiveBurst);
const wayback = new WaybackClient(queue, config, shutdown);
const cache = new CacheService(config);
const proxy = new ProxyService(cache, wayback, config);
const server = new TimeMachineService(config, proxy, cache, urlValidator, shutdown);
server.start();
```

### Research Enhancement

- **Pattern — Unassigned helpers:** Three functions have no specified module home:
  - `unwrapNestedProxyUrl` (timemachine.ts:221–241) — URL transformation (not validation); belongs in `src/lib/url-rewriter.ts`. Must receive `proxyBaseHostname` as an explicit parameter (not closed over). `proxyBaseHostname` stays in `Config`, injected where needed.
  - `isCacheEntry` type guard (timemachine.ts:123–133) — export alongside `CacheEntry` in `src/models/cache.ts`. Note: existing guard does not validate `archiveTime` — fix the inconsistency when extracting.
  - `hasStatus` (timemachine.ts:300–304) — shared error-narrowing utility used by both HTTP and WS handlers; belongs in new module `src/lib/errors.ts`.
- **Pattern — WaybackClient missing constants:** `ARCHIVE_URL_PREFIX` → WaybackClient private field derived from `config.archivePrefix` (security boundary, must trace to config, not a free-standing export). `BACKOFF_STEPS_MS` → WaybackClient private constant. `maxQueueSize` → keep as ArchiveRequestQueue constructor parameter (default 200, no env override).
- **Pattern — Late env read:** `WS_KEEPALIVE_MS` is read at timemachine.ts:963 (outside the config block). Must be consolidated into `loadConfig()` as `wsKeepaliveMs`.
- **Pattern — Two prefetch methods:** Keep both `prefetchResources(html, time, skip)` and `prefetchResourceUrls(urls, time, skip)` in ProxyService. Two entry points serve distinct call sites: `prefetchResources` for raw HTML input; `prefetchResourceUrls` for pre-computed URL lists (avoids double-parsing on CACHE MISS path).
- **Pattern — Naming error in ProxyService spec:** `sendCached` does not exist in current code — the cache-HIT path is inline inside `proxyFetch`. If extracting, name it `assembleCachedResponse` (returns `ProxyResult`; does not write to a response object). Violates the plan's own no-logic-changes constraint if introduced as a new method.
- **Ref:** repo-research-researcher (Gaps 1–7, 10)

---

## Questions to Resolve

### Critical (P1 - Blockers)

1. **Monorepo vs single-package turborepo** — Do you want a full `apps/proxy` + `packages/` monorepo structure now, or turborepo in single-package mode at the repo root? *Default: single-package mode at root. Simpler, Dockerfile stays the same depth, no `apps/` directory needed.*

2. **ShutdownController injection into WaybackClient** — `abortableSleep` needs the global abort signal. Should `ShutdownController` be injected into `WaybackClient`, or should the signal be passed per-call? *Default: inject controller into constructor.*

### Important (P2 - Affects implementation)

3. **`url-validator` as a module vs class** — The validator functions are stateless but `isHostWhitelisted` currently closes over `whitelistHosts`. If we parameterize it, all callers pass the value; if we make it a class, `whitelistHosts` is set at construction. *Default: module with parameters — fewer abstractions, easier to test.*

4. **Test scope** — Write unit tests for `lib/` and `clients/` only, or also integration tests for the HTTP/WS handlers? *Default: unit tests for lib + clients now; HTTP/WS integration tests as a follow-on.*

---

## Implementation Order (TDD)

**Each step: write failing test → implement → verify green → next step.**

### Step 1: Test infrastructure + pnpm + turborepo

- **Implement:**
  - Remove `package-lock.json`, install pnpm (`corepack enable && corepack prepare pnpm@latest`)
  - Add `pnpm-workspace.yaml` (minimal, single-package)
  - Add `turbo` to `devDependencies`, add `turbo.json`:
    ```json
    {
      "$schema": "https://turbo.build/schema.json",
      "tasks": {
        "build": { "outputs": ["dist/**"] },
        "typecheck": {},
        "test": { "outputs": ["coverage/**"] }
      }
    }
    ```
  - Add jest + ts-jest to devDependencies, add `jest.config.ts`
  - Update `package.json` scripts: add `"test": "jest"`, update `"build"` entry point to `src/index.ts`
  - Update `tsconfig.json`: `"include": ["src/**/*", "tests/**/*"]`
- **Validation:** `pnpm install` succeeds; `pnpm run typecheck` still passes (no src/ yet, just updated tsconfig)

### Step 2: Models

- **Test:** none (pure type declarations; TypeScript compiler is the test)
- **Implement:** Create `src/models/cache.ts`, `src/models/config.ts`, `src/models/proxy.ts`, `src/models/queue.ts`, `src/models/websocket.ts` — move all interfaces and types from `timemachine.ts` verbatim
- **Validation:** `pnpm run typecheck` passes

### Step 3: src/lib/config.ts

- **Test:** `tests/lib/config.test.ts` — verify defaults when env vars are absent; verify correct types when env vars are set
- **Implement:** Extract all `process.env` reads into `loadConfig(): Config`; ensure `mkdirSync` for `cacheDir` lives here
- **Validation:** Tests green; `pnpm run typecheck` passes

### Step 4: src/lib/shutdown.ts

- **Test:** `tests/lib/shutdown.test.ts` — verify `abortableSleep` resolves after ms; verify it rejects when aborted mid-sleep
- **Implement:** Extract `ShutdownController` (wraps `AbortController`) and `abortableSleep`
- **Validation:** Tests green

### Step 5: src/lib/queue.ts — ArchiveRequestQueue

- **Test:** `tests/lib/queue.test.ts` — verify concurrency cap; verify rate limiting; verify `abort()` rejects pending
- **Implement:** Move `ArchiveRequestQueue` class verbatim; export it
- **Validation:** Tests green; `pnpm run typecheck` passes

### Step 6: src/lib/url-validator.ts

- **Test:** `tests/lib/url-validator.test.ts` — cover valid URLs, invalid protocol, private IP ranges, wildcard whitelist, pattern whitelist, invalid URL strings
- **Implement:** Extract `validateTargetUrl`, `isHostWhitelisted`, `parseWhitelist`; parameterize `whitelistHosts` in `isHostWhitelisted`
- **Validation:** Tests green

### Step 7: src/lib/url-rewriter.ts

- **Test:** `tests/lib/url-rewriter.test.ts` — cover `rewriteArchiveLinks` (absolute + relative), `rewriteCssUrls`, `rewriteImageUrlsFiltered`, `stripWaybackToolbar`, `sanitizeTimeParam`, `collectWaybackResourceUrls`
- **Implement:** Move all 10 regex constants and all rewrite functions; parameterize `proxyBase`, `prefix` instead of closing over them
- **Validation:** Tests green

### Step 8: src/clients/wayback.ts — WaybackClient

- **Test:** `tests/clients/wayback.test.ts` — mock `fetch`; verify retry on retryable error codes; verify rejection on non-retryable; verify SSRF guard (non-archive URL rejected); verify resource type headers
- **Implement:** `WaybackClient` class with constructor injection of `ArchiveRequestQueue` and `ShutdownController`; move `BROWSER_HEADERS`, `BROWSER_UA`, `RETRYABLE_ERROR_CODES`, `isRetryable`, `fetchFromArchive` logic
- **Depends on:** Steps 5, 7
- **Validation:** Tests green

### Step 9: src/services/cache.ts — CacheService

- **Test:** `tests/services/cache.test.ts` — mock `fs.promises`; verify `get` returns null on ENOENT; verify `put` writes correct JSON; verify `handleCacheClear` filters by type and domain
- **Implement:** `CacheService` class; move `cacheKey`, `cacheGet`, `cachePut`, `handleCacheClear`, `domainMatcher`, `matchesTypeFilter`
- **Depends on:** Steps 2, 3
- **Validation:** Tests green

### Step 10: src/services/proxy.ts — ProxyService

- **Test:** `tests/services/proxy.test.ts` — mock `CacheService` and `WaybackClient`; verify cache HIT path; verify cache MISS → fetch → cache path for HTML, CSS, binary; verify `fetchAndCacheImage` caches correctly
- **Implement:** `ProxyService` class; move `proxyFetch`, `sendCached`, `fetchAndCacheImage`, `prefetchResources`, `getCachedResourceUrls`; inject `CacheService`, `WaybackClient`, `Config`
- **Depends on:** Steps 6, 7, 8, 9
- **Validation:** Tests green

### Step 11: src/services/time-machine.ts — TimeMachineService

- **Test:** _(deferred to follow-on — HTTP/WS integration tests require a live server or supertest setup; out of scope for this plan)_
- **Implement:** `TimeMachineService` class; move HTTP handler, WebSocket handler, CORS logic, shutdown wiring; inject `ProxyService`, `CacheService`, url-validator module, `Config`, `ShutdownController`
- **Depends on:** Steps 3, 6, 9, 10
- **Validation:** `pnpm run typecheck` passes; manual smoke test

### Step 12: src/index.ts — Entry point + wiring

- **Implement:** Wire all classes together; remove all code from `timemachine.ts` (keep as empty re-export or delete)
- **Validation:** `pnpm run build` produces `dist/timemachine.js`; `node dist/timemachine.js` starts cleanly

### Step 13: Dockerfile + cloudbuild.yaml + deploy.sh

- **Implement:**
  - `Dockerfile`: replace `COPY timemachine.ts ./` with `COPY src/ ./src/`; add `COPY pnpm-lock.yaml ./`; replace `npm install` with `npm install -g pnpm && pnpm install --frozen-lockfile`
  - `cloudbuild.yaml`: replace `npm run build` with `pnpm run build` (or `npx turbo build`)
  - `deploy.sh`: replace `npm` references with `pnpm`
  - `tsconfig.json`: verify `include` covers `src/**/*`
- **Validation:** `docker build .` succeeds locally

### Final: Cleanup

- [ ] Delete original `timemachine.ts` (or replace with `export * from './src/index'` shim if external scripts reference it)
- [ ] Remove `tsconfig.tsbuildinfo` if stale
- [ ] Run full `pnpm test && pnpm run typecheck && pnpm run build`
- [ ] Verify `dist/timemachine.js` starts and responds to HTTP requests
- **Validation:** All tests pass; build artifact boots; lint clean

### Research Enhancement

- **Framework — Biome (Gap 8):** Step 1 is missing Biome setup. Add to Step 1:
  - `pnpm add -D --save-exact @biomejs/biome`
  - Create `biome.json`: `vcs.useIgnoreFile: true`, `formatter.indentStyle: "tab"`, `quoteStyle: "double"`, `semicolons: "always"`, `linter.rules.recommended: true`, `files.ignore: ["dist/**", "coverage/**"]`
  - Add package.json scripts: `"lint": "biome lint ."`, `"check": "biome check ."`, `"check:fix": "biome check --write ."`
  - Add turbo.json root tasks: `"//#lint": {}`, `"//#check": {}`, `"//#check:fix": { "cache": false }` (write-mode tasks must not be cached)
  - Step 1 validation must include `pnpm run check` passes (0 violations).
- **Framework — pnpm-workspace.yaml (Gap 12):** Create as an empty file (no `packages:` key). Never use `packages: ['.']` — this forces `pnpm add -w` on every root-level install.
- **Best-practice — Dockerfile pnpm (Gap 9):** Replace `npm install -g pnpm` with Corepack. The `node:22-bookworm` image ships Corepack < 0.31.0 which fails signature verification on recent pnpm releases (npm signing keys rotated early 2025). Required sequence:
  ```dockerfile
  ENV PNPM_HOME="/pnpm"
  ENV PATH="$PNPM_HOME:$PATH"
  ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  RUN npm install -g corepack@latest && corepack enable && corepack prepare pnpm@<pinned-version> --activate
  ```
  Pinned version must match `"packageManager"` field in `package.json`.
- **Best-practice — loadConfig split (Gap 11):** Split `loadConfig()` (pure — env reads + type coercion only) from `ensureCacheDir(cacheDir: string)` (impure side effect). Unit tests for `loadConfig()` need zero mocks. `new URL(malformed)` throws `TypeError` synchronously — test with `expect(() => loadConfig()).toThrow(TypeError)`. `ensureCacheDir` tested separately with real temp dir.
- **Best-practice — Volta + packageManager (Gap 13):** Add `"packageManager": "pnpm@<version>"` field to `package.json` (Corepack standard). Keep `"volta": { "node": "25.2.0" }`. Do not rely on `volta.pnpm` — Volta pnpm support is experimental; requires `VOLTA_FEATURE_PNPM=1` per machine and will silently fall back to system pnpm without it.
- **Pattern — tsconfig include timing (Gap 10):** Do NOT replace `timemachine.ts` in `include` at Step 1. Add alongside it: `"include": ["timemachine.ts", "src/**/*", "tests/**/*"]`. Remove `timemachine.ts` from `include` only at Step 12 when the file is deleted or retired.
- **New step required — Logging with pino:** The plan has no logging step. Structured multi-level logging must be added as a new step before Step 2 (logging is a dependency of all service/client modules). Current code uses raw `console.log/warn/error` throughout — these must all be replaced. Specification:
  - Library: `pino` (project standard). Add `pnpm add pino` + `pnpm add -D @types/pino`.
  - Create `src/lib/logger.ts`: exports a singleton `pino` instance with `level` read from `LOG_LEVEL` env var (default `"info"`).
  - Log levels and content:
    - **`info`** (startup + one line per connection only):
      - timemachine.ts:45 — startup config object → `logger.info({ port, hostname, cacheEnabled, ... }, "TimeMachine starting")`
      - timemachine.ts:1113–1114 — server/WS listening → `logger.info({ host, port }, "listening")`
      - timemachine.ts:966 — WS client connected → `logger.info({ remoteAddress }, "ws client connected")`
      - timemachine.ts:1096 — WS client disconnected → `logger.info("ws client disconnected")`
      - timemachine.ts:1101 — shutdown → `logger.info("shutting down")`
      - HTTP handler: one `logger.info({ method, path, status, durationMs })` per request at completion
    - **`debug`** (full request lifecycle):
      - timemachine.ts:566 — `${url} => ${archiveUrl}` → `logger.debug({ url, archiveUrl }, "resolved archive url")`
      - timemachine.ts:721 — `[CACHE HIT]` → `logger.debug({ targetUrl, time }, "cache hit")`
      - timemachine.ts:752 — `${targetUrl} => ${archiveUrl}` → `logger.debug({ targetUrl, archiveUrl }, "cache miss, fetching")`
      - WS: frame events (message type, id, url, resolved time)
      - Wayback retry timing (attempt number, backoff ms)
      - Rewrite pass applied (html/css, url count rewritten)
      - Response content-type and size bytes
    - **`warn`**: timemachine.ts:151 (cache read fail), :450 (retryable connection error + retry count), :586 (prefetch image fail), :606 (prefetch resource fail), :689 (cache clear error), :973 (WS client unresponsive)
    - **`error`**: timemachine.ts:171 (cache write fail), :650 (cache dir read fail), :926 (upstream request failed), :1078 (WS upstream failed)
  - `cacheClearToken` must never appear in any log output — validated in `tests/lib/logger.test.ts`.
  - All injected classes (`WaybackClient`, `CacheService`, `ProxyService`, `TimeMachineService`) receive the logger via constructor injection: `constructor(private readonly logger: pino.Logger, ...)`.
  - Tests: `tests/lib/logger.test.ts` — verify `LOG_LEVEL=debug` enables debug output; verify `LOG_LEVEL=info` suppresses debug; verify token redaction.
- **Ref:** framework-docs-researcher (Gaps 8, 12), best-practices-researcher (Gaps 9, 11, 13), repo-research-researcher (Gap 10), user requirement (logging)

---

## Acceptance Criteria

- [x] `pnpm install` succeeds from clean checkout (no npm)
- [x] `pnpm run build` produces `dist/timemachine.js` via esbuild from `src/index.ts`
- [x] `pnpm run typecheck` passes with zero errors
- [x] `pnpm test` passes — all unit tests green
- [x] `pnpm exec turbo build` works (turborepo pipeline)
- [x] `node dist/timemachine.js` starts and serves requests identically to the original
- [x] `docker build .` succeeds
- [x] No logic changes — all existing behavior preserved exactly

### Research Enhancement

- **Framework — Biome (Gap 8):** Add: `pnpm run check` exits 0 (no lint or format violations).
- **Logging (user requirement):** Add: `LOG_LEVEL=debug node dist/timemachine.js` emits debug-level lifecycle events; `LOG_LEVEL=info` suppresses debug output; `cacheClearToken` never appears in any log output.
- **Ref:** framework-docs-researcher (Gap 8), user requirement (logging)

---

## Security Considerations

- `validateTargetUrl` and `isHostWhitelisted` must be tested in isolation (Step 6) before being wired into the HTTP and WS handlers — these are the SSRF guards
- No new security surface is added by this refactor
- Injection of `Config` must not expose `cacheClearToken` via logs or serialization — it already isn't, but the new `CacheService` constructor should not log the token

## Performance Considerations

- esbuild bundles all `src/**` into a single `dist/timemachine.js` — module splitting has zero runtime overhead
- Turborepo adds local task caching: unchanged modules don't rebuild (speeds up CI)
- `ArchiveRequestQueue` remains a process-level singleton (instantiated once in `index.ts`) — no behavioral change

---

## Related Files

| File | Change |
|------|--------|
| `timemachine.ts` | Deleted (contents moved to `src/`) |
| `src/index.ts` | Created — entry point |
| `src/models/*.ts` | Created — 5 files |
| `src/lib/*.ts` | Created — 5 files |
| `src/clients/wayback.ts` | Created |
| `src/services/*.ts` | Created — 3 files |
| `tests/**/*.test.ts` | Created — 8 test files |
| `package.json` | pnpm, turbo, jest added |
| `pnpm-workspace.yaml` | Created |
| `turbo.json` | Created |
| `tsconfig.json` | `include` updated |
| `Dockerfile` | pnpm + src/ copy |
| `cloudbuild.yaml` | npm → pnpm |
| `deploy.sh` | npm → pnpm |

---

## Enrichment Summary

**Deepened:** 2026-05-20
**Gaps found:** 13 (+ 1 user requirement: structured pino logging)
**Agents used:** spec-flow-analyzer, framework-docs-researcher, repo-research-researcher, best-practices-researcher
**Second opinion:** no — timed out (OpenRouter/gpt-5.4)
**Confidence:** N/A

### Key Discoveries
- Three functions (`unwrapNestedProxyUrl`, `isCacheEntry`, `hasStatus`) have no module home in the plan; each requires a specific placement decision before Step 2 begins
- `sendCached` in the ProxyService spec is a naming error — the function does not exist in `timemachine.ts`; the cache-HIT branch is inline in `proxyFetch`
- Dockerfile `npm install -g pnpm` is non-reproducible; requires Corepack with `npm install -g corepack@latest` workaround (`node:22-bookworm` ships Corepack < 0.31.0, which fails signature verification on recent pnpm releases)
- Biome setup described in summary has no implementation step, biome.json spec, acceptance criterion, or turbo task
- `tsconfig.json` include change in Step 1 as written would silently drop typecheck coverage of `timemachine.ts` for all 11 transition steps
- No logging infrastructure exists in the plan; pino with debug/info/warn/error levels is required as a new step before Step 2

### New Risks Identified
- **High — Naming error in ProxyService spec:** `sendCached` does not exist; implementer will either invent new logic (violates no-logic-changes rule) or be blocked; rename to `assembleCachedResponse` or remove from spec
- **High — Dockerfile build non-reproducibility:** `npm install -g pnpm` fetches latest at build time; fix: Corepack with pinned version matching `packageManager` field
- **Medium — Biome acceptance gap:** No lint/format enforcement in CI means "lint clean" in Final step is unverifiable
- **Medium — tsconfig coverage gap:** 11-step window with no typecheck on the live monolith if include is changed at Step 1 as written
- **Low — `isCacheEntry` guard omits `archiveTime`:** Existing inconsistency; low risk since the field is always written by `cachePut`, but should be corrected when extracting

---

## Next Steps

When ready to implement, run:
- `/wiz:work plans/modular-refactor-pnpm-turborepo.md` — execute the plan step by step
- `/wiz:deepen-plan` — get more detail on any specific step
- `/wiz:brainstorming` — discuss the architecture before starting
