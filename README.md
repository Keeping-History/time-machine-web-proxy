# Time Machine Web Proxy

A proxy server that fetches archived web content from the [Wayback Machine](https://web.archive.org) and serves it with the Wayback toolbar stripped, URLs rewritten to route through the proxy, and aggressive disk caching to minimize upstream requests.

Supports both HTTP and WebSocket interfaces.

> Adapted from [timeprox](https://github.com/remino/timeprox) by [Rémi](https://remino.net).

---

## Features

- Fetches pages from `web.archive.org` at a configurable point in time
- Strips the Wayback Machine toolbar and injected JS
- Rewrites HTML/CSS links to route through the local proxy
- Filesystem-tree disk cache (`${CACHE_DIR}/v2/<time>/<host>/<path>`) populated by [`wayback-machine-downloader`](https://www.npmjs.com/package/wayback-machine-downloader)
- Redis-backed BullMQ job queue (foreground exact-URL jobs + background domain-crawl jobs)
- Optional outbound HTTP proxy (ProxyMesh / Squid) via `undici.setGlobalDispatcher`
- WebSocket API for programmatic access
- SSRF protection: blocks private/internal IPs and non-HTTP protocols
- Optional host whitelist
- Bearer token protection on the cache management API
- Containerized; deployed on Kubernetes (k3s) via Argo CD GitOps

See [docs/deployment.md](docs/deployment.md) for production deployment (k3s, Argo CD, Redis, GCS FUSE cache, outbound proxy).

---

## Quick Start (Docker)

```bash
cp .env .env.local   # adjust values as needed
docker compose up --build -d
```

The proxy listens on port `8765` by default.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TIMEMACHINE_PORT` | `8765` | Port the server listens on |
| `LISTENER` | `0.0.0.0` | Bind address |
| `PROXY_BASE_URL` | _(derived from `LISTENER:PORT`)_ | Public base URL used when rewriting proxied links. Required when running behind a reverse proxy or Ingress (e.g. `https://timemachine.example.com`) |
| `ARCHIVE_TIME` | `19980101000000` | Default Wayback timestamp (`YYYYMMDDHHmmss`) |
| `PROXY_PREFIX` | _(empty)_ | Optional path prefix appended between timestamp and URL |
| `CACHE_DIR` | `/app/cache` | Root directory for cached responses. The v2 tree lives under `${CACHE_DIR}/v2/`. |
| `CACHE_ENABLED` | `true` | Set to `false` to disable disk caching |
| `CACHE_CLEAR_TOKEN` | _(empty)_ | Bearer token required to call admin endpoints (`DELETE /cache`, `POST /crawl`). If empty, both endpoints are disabled (return `403`). |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin (`*` for open) |
| `WHITELIST_HOSTS` | `*` | Comma-separated list of allowed target hostnames (supports `*.example.com` wildcards). `*` allows all. |
| `REDIS_URL` | `redis://localhost:6379` | ioredis connection URL for BullMQ |
| `BULLMQ_PREFIX` | `tm` | Namespace prefix for BullMQ Redis keys |
| `DOMAIN_CRAWL_ENABLED` | `true` | When true, HTML cache misses fire a background domain crawl |
| `WORKER_CONCURRENCY` | `2` | Concurrent foreground (exact-URL) jobs |
| `WORKER_RATE_LIMIT_PER_SEC` | `1` | Outbound request ceiling. `1`/sec → 60 req/min, which stays under Wayback's sustained-IP-block threshold. |
| `DOWNLOADER_THREADS_COUNT` | `3` | `wayback-machine-downloader` internal threads per job |
| `CRAWL_MAX_CDX_PAGES` | `50` | CDX preflight cap. At default (50 pages × ~3000 URLs/page) ≈ 150k URLs per crawl. |
| `CRAWL_JOB_PRIORITY` | `10` | BullMQ priority for crawl-derived jobs (lower = higher priority). Foreground exact requests stay at `1`, so crawls never starve live traffic. Valid range `2`–`2097152`. |
| `SNAPSHOT_WINDOW_DAYS` | `30,365,3650,0` | Widening search windows (in days) for finding the closest Wayback snapshot around the requested time. Tried in order; `0` = unbounded. CSV of non-negative integers. |
| `ALLOW_LATER_FALLBACK` | `false` | Bidirectional ("closest snapshot in either direction") resolution for **direct/top-level URLs** (the URL the user typed). Default `false` = strict at-or-before: a user who asked for a specific time should see the page state at that time, not a drifted later capture. |
| `ASSET_LATER_FALLBACK` | `true` | Bidirectional resolution for **asset URLs** (images, CSS, JS, fonts, media — classified by file extension). Default `true` because asset captures rarely align with the page's exact requested timestamp; strict at-or-before would 404 sub-resources that exist a few hours/days later. Mirrors web.archive.org's own sub-resource behavior. |
| `OUTBOUND_PROXY_URLS` | _(empty)_ | CSV of HTTP/HTTPS proxy URLs for outbound Wayback fetches (e.g. `http://us-wa-load-balancer.proxymesh.com:31280`). One URL → single proxy; multiple URLs → rotation. Empty = direct. |
| `OUTBOUND_PROXY_CHOOSER` | `sequential` | Rotation strategy when multiple `OUTBOUND_PROXY_URLS` are set: `sequential` (round-robin) or `random` (uniform per-request). Case-insensitive. Ignored when only one URL is provided. |
| `OUTBOUND_PROXY_USERNAME` | _(empty)_ | Basic-auth username applied to every proxy URL. Empty = IP whitelist auth. |
| `OUTBOUND_PROXY_PASSWORD` | _(empty)_ | Basic-auth password. Required when `OUTBOUND_PROXY_USERNAME` is set. |
| `OUTBOUND_PROXY_COOLDOWN_SECONDS` | `60` | Base cooldown applied to a proxy after a failure (transport error, 407, 502/503/504). Re-probed at expiry; each consecutive re-probe failure extends the cooldown linearly (X, 2X, 3X, ...). All proxies cooled-down ⇒ dispatch throws `no healthy proxy`. Startup probe failures use the same path. |

---

## HTTP API

### `GET /?url=<url>&time=<timestamp>`

Fetches a URL from the archive at the given timestamp and returns the response with URLs rewritten.

| Parameter | Required | Description |
|---|---|---|
| `url` | Yes | Full URL to fetch (e.g. `https://example.com`) |
| `time` | No | 14-digit Wayback timestamp (`YYYYMMDDHHmmss`). Defaults to `ARCHIVE_TIME`. Interpreted as **"on or before this date"** — the proxy serves the closest snapshot whose Wayback timestamp is ≤ `time`. `X-Archive-Time` in the response reflects the actual snapshot timestamp, which may differ from the requested `time`. |

**Snapshot resolution.** The worker pre-flights the CDX API with widening windows (`SNAPSHOT_WINDOW_DAYS`) and selects the closest snapshot across all URL variants (https/http × bare/www). The resolver runs in one of two modes per request, picked from the URL's file extension:

- **Direct/top-level URLs** (HTML pages, extensionless paths, anything not in the asset-extension allowlist): governed by `ALLOW_LATER_FALLBACK`. Default `false` → strict at-or-before; returns `404 Not found in archive` if no snapshot exists at or before the requested time.
- **Asset URLs** (`.gif`/`.png`/`.css`/`.js`/`.woff2`/`.mp4`/etc.): governed by `ASSET_LATER_FALLBACK`. Default `true` → bidirectional closest; the resolver picks whichever capture is nearest to the requested time in either direction.

This asymmetric default means a user who navigates to a 2001-09-13 page sees the page captured **at or before** that date, but the page's images, CSS, and scripts can come from the closest capture in either direction — useful because asset captures are typically sparser than HTML captures and a strict match would 404 most sub-resources.

**Negative caching.** A `404` result is cached as a zero-byte sentinel at `<CACHE_DIR>/v2/<time>/<host>/.notfound/<sha256-prefix>`. Subsequent requests for the same `(url, time)` short-circuit at the cache lookup — no CDX or downloader work. Sentinels are cleared along with cached files by `DELETE /cache` (including the `?domain=` filter).

**Response headers:**

| Header | Description |
|---|---|
| `X-Archive-Url` | The resolved Wayback Machine URL |
| `X-Original-Url` | The original requested URL |
| `X-Archive-Time` | The actual timestamp of the archived snapshot |
| `X-Cache` | `HIT` or `MISS` |

**Errors:**

| Status | Reason |
|---|---|
| `400` | Missing or invalid `url`/`time` parameter |
| `403` | Private/internal host, disallowed protocol, or host not whitelisted |
| `404` | No snapshot found in archive |
| `451` | Domain is on the operator blocklist (see **Blocked domains** below) |
| `500` | Upstream fetch failed |

**Blocked domains.** An optional `config.json` at the root of the cache bucket (i.e. `<CACHE_DIR>/config.json` — the bucket is FUSE-mounted at `CACHE_DIR`) lists domains the proxy must never retrieve, cache, or serve:

```json
{
  "blocked_domains": ["doubleclick.net", "*.ads.example.com"]
}
```

`*.host` matches every subdomain plus the apex (same semantics as `WHITELIST_HOSTS`). Requests for a blocked domain fail with `451 Domain blocked: <host>` (an `error` frame with `status: 451` on the SSE/WebSocket paths), and prewarm skips blocked asset hosts embedded in allowed pages. The file is re-read at most once per minute, so edits take effect without a restart; a missing file simply means no blocklist.

---

### `DELETE /cache`

Clears cached entries. Supports optional filters.

If `CACHE_CLEAR_TOKEN` is set, requests must include:

```
Authorization: Bearer <token>
```

Returns `401` if the token is missing or incorrect.

| Query param | Description |
|---|---|
| `type` | **Removed in v2.** Returns `410 Gone` — the filesystem-tree layout has no per-entry MIME metadata. |
| `domain` | Filter by host directory (supports `*.example.com` wildcards) |

**Response:**

```json
{ "deleted": 12, "errors": 0 }
```

---

### `POST /crawl`

Admin-triggered domain crawl. Enqueues an `archive-crawl` job for `<host>` over the calendar-day window of `<time>`, downloading every URL under `<host>/*` that the Wayback Machine has captured that day. Unlike the fire-and-forget crawls triggered by HTML cache misses, this endpoint:

- **Bypasses** the per-host 24h Redis budget — explicit operator actions aren't rate-limited.
- **Returns** concrete error status codes instead of swallowing failures.
- **Still respects** `WHITELIST_HOSTS`, `CRAWL_MAX_CDX_PAGES`, and the `DOMAIN_CRAWL_ENABLED` kill switch.

Uses the same `CACHE_CLEAR_TOKEN` for authentication (shared admin token; split into separate env vars if you need finer-grained auth).

| Query param | Required | Description |
|---|---|---|
| `host` | Yes | Bare hostname (`example.com` or `www.example.com`). Only letters/digits/dots/hyphens — no scheme, path, or port. |
| `time` | No | 14-digit Wayback timestamp. Defaults to `ARCHIVE_TIME`. Crawl window is the calendar day of this timestamp. |
| `skip_preflight` | No | Set to `true` (case-insensitive) to bypass the `CRAWL_MAX_CDX_PAGES` CDX preflight check. Use when archive.org's CDX endpoint is rejecting your egress IP but the downloader path still works. **You lose the runaway-crawl size guard** — only use when you already know the target host's archived footprint. Any value other than literal `true` is ignored. |

**Example:**

```bash
curl -X POST -H "Authorization: Bearer $CACHE_CLEAR_TOKEN" \
  "http://localhost:8765/crawl?host=www.aol.com&time=20010913000000"

# Bypass the size-cap preflight when CDX is unreachable from your egress IP:
curl -X POST -H "Authorization: Bearer $CACHE_CLEAR_TOKEN" \
  "http://localhost:8765/crawl?host=www.aol.com&time=20010913000000&skip_preflight=true"
```

**Responses:**

| Status | Meaning |
|---|---|
| `202 Accepted` | Job enqueued. Body: `{ "host": "...", "time": "...", "preflightSkipped": false }`. The crawl runs asynchronously on the worker. |
| `400 Bad Request` | `host` missing or contains illegal characters; or `time` is not 14 digits. |
| `401 Unauthorized` | Missing or wrong `Authorization` header. |
| `403 Forbidden` | `CACHE_CLEAR_TOKEN` is empty (endpoint disabled) **or** host is not in `WHITELIST_HOSTS`. |
| `413 Payload Too Large` | CDX preflight reports more pages than `CRAWL_MAX_CDX_PAGES`. Raise the cap, pick a narrower day, or pass `skip_preflight=true` if you trust the host's size. |
| `500 Internal Server Error` | CDX preflight network failure (e.g. archive.org rejecting your egress IP). The error body includes the underlying cause — typical codes: `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`. Route through `OUTBOUND_PROXY_URLS` or pass `skip_preflight=true`. |
| `503 Service Unavailable` | `DOMAIN_CRAWL_ENABLED=false` (kill switch). |

Progress is observable via bull-board (see `docker-compose.yml`) or the BullMQ events on the `archive-crawl` queue.

**Note on egress:** All `fetch()` calls in this process (including the CDX preflight) route through `OUTBOUND_PROXY_URLS` when set — `installOutboundProxy` calls `setGlobalDispatcher` at startup. If archive.org is refusing connections from your datacenter IP, point `OUTBOUND_PROXY_URLS` at a residential / ProxyMesh-style proxy and restart.

---

## WebSocket API

Connect to `ws://<host>:<port>/ws` (or `wss://` when behind TLS).

### Request

```json
{
  "type": "fetch",
  "id": "optional-correlation-id",
  "url": "https://example.com",
  "time": "19980101000000"
}
```

`time` is optional and defaults to `ARCHIVE_TIME`.

### Success response

```json
{
  "type": "result",
  "id": "optional-correlation-id",
  "html": "<body>...</body>",
  "contentType": "text/html; charset=utf-8",
  "archiveUrl": "https://web.archive.org/web/19980101000000/https://example.com",
  "originalUrl": "https://example.com",
  "archiveTime": "19980101120000",
  "cache": "MISS"
}
```

For non-HTML responses, `html` contains a base64-encoded body.

### Error response

```json
{
  "type": "error",
  "id": "optional-correlation-id",
  "status": 403,
  "message": "Host not whitelisted"
}
```

---

## Development

**Requirements:** Node.js 22, pnpm 10.26+ (pinned via `.mise.toml`), a running Redis instance.

```bash
docker compose up -d redis   # local Redis on :6379
pnpm install
pnpm dev
```

The source lives under `src/` and is bundled by `esbuild` into `dist/`. The Docker image runs the bundled output.

**pnpm scripts:**

| Script | Description |
|---|---|
| `pnpm build` | Bundle the server with esbuild |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm test` | Run the Jest suite |
| `pnpm check` | Biome format + lint |

---

## Deployment (Kubernetes / k3s + Argo CD)

Production runs on a **local k3s cluster** (2 nodes, joined over Tailscale/WireGuard). Deployment is **GitOps**: there is no manual deploy step from this repo.

The pipeline has three independent layers:

1. **Build** — pushing to `main` triggers `.github/workflows/build.yml`, which builds the image and pushes it to **GHCR**: `ghcr.io/keeping-history/time-machine-web-proxy:{sha,latest}`. The workflow touches no cluster credentials and no manifests.
2. **Rollout** — **Argo CD** runs in the cluster and reconciles the manifests in the separate **`Keeping-History/infra`** repo (`apps/time-machine/`). Argo CD Image Updater watches GHCR and rolls out new image tags automatically.
3. **Runtime** — the app runs as a single-replica Deployment (the in-process BullMQ worker must stay scheduled) alongside a `gcsfuse` native sidecar that mounts the GCS cache bucket at `/app/cache`, plus an in-cluster Redis Service for the BullMQ queue. TLS/WSS is terminated at the Ingress; the container receives plain HTTP.

**To ship a change:**

```bash
git push origin main   # GitHub Actions builds + pushes to GHCR; Argo CD rolls it out
```

Config changes (non-secret env) land in `Keeping-History/infra` (`apps/time-machine/configmap.yaml`) and are reconciled by Argo CD the same way. Secrets live in the out-of-band `time-machine-secrets` Kubernetes Secret.

**GitHub secrets required:** none for deploy — `build.yml` authenticates to GHCR with the workflow's `GITHUB_TOKEN`. There are no GCP service-account keys or cluster credentials in this repo.

The cache is the GCS bucket `tm-cache-723408812472` mounted at `/app/cache` via GCS FUSE, so cached responses survive pod restarts.

> The legacy Cloud Build → Cloud Run pipeline (`cloudbuild.yaml`, `deploy.sh`, `.gcloudignore`) is retained in-tree for reference only and is **not** used by the current deploy.

See [docs/deployment.md](docs/deployment.md) for the full production setup and [docs/post-deploy.md](docs/post-deploy.md) for the live verification checklist.

---

## Security

- Only `http:` and `https:` protocols are allowed as targets
- Private and loopback addresses are blocked (`localhost`, `127.x`, `10.x`, `192.168.x`, etc.)
- All archive fetches are constrained to `https://web.archive.org/` — arbitrary upstream fetches are not possible
- CORS is restricted to `CORS_ORIGIN`
- `WHITELIST_HOSTS` can restrict which domains can be proxied
- `DELETE /cache` can be protected with a Bearer token via `CACHE_CLEAR_TOKEN`

---

## Credits

Based on [timeprox](https://github.com/remino/timeprox) by [Rémi](https://remino.net).
