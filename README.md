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
- Docker support with Google Cloud Run deployment

See [docs/deployment.md](docs/deployment.md) for production deployment (Memorystore, VPC Connector, outbound proxy).

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
| `PROXY_BASE_URL` | _(derived from `LISTENER:PORT`)_ | Public base URL used when rewriting proxied links. Required when running behind a reverse proxy or on Cloud Run (e.g. `https://your-service.run.app`) |
| `ARCHIVE_TIME` | `19980101000000` | Default Wayback timestamp (`YYYYMMDDHHmmss`) |
| `PROXY_PREFIX` | _(empty)_ | Optional path prefix appended between timestamp and URL |
| `CACHE_DIR` | `/app/cache` | Root directory for cached responses. The v2 tree lives under `${CACHE_DIR}/v2/`. |
| `CACHE_ENABLED` | `true` | Set to `false` to disable disk caching |
| `CACHE_CLEAR_TOKEN` | _(empty)_ | Bearer token required to call `DELETE /cache`. If empty, the endpoint is unprotected. |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin (`*` for open) |
| `WHITELIST_HOSTS` | `*` | Comma-separated list of allowed target hostnames (supports `*.example.com` wildcards). `*` allows all. |
| `REDIS_URL` | `redis://localhost:6379` | ioredis connection URL for BullMQ |
| `BULLMQ_PREFIX` | `tm` | Namespace prefix for BullMQ Redis keys |
| `DOMAIN_CRAWL_ENABLED` | `true` | When true, HTML cache misses fire a background domain crawl |
| `WORKER_CONCURRENCY` | `2` | Concurrent foreground (exact-URL) jobs |
| `WORKER_RATE_LIMIT_PER_SEC` | `1` | Outbound request ceiling. `1`/sec → 60 req/min, which stays under Wayback's sustained-IP-block threshold. |
| `DOWNLOADER_THREADS_COUNT` | `3` | `wayback-machine-downloader` internal threads per job |
| `CRAWL_MAX_CDX_PAGES` | `50` | CDX preflight cap. At default (50 pages × ~3000 URLs/page) ≈ 150k URLs per crawl. |
| `OUTBOUND_PROXY_URLS` | _(empty)_ | CSV of HTTP/HTTPS proxy URLs for outbound Wayback fetches. One URL → single proxy; multiple URLs → rotation. Empty = direct. |
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
| `time` | No | 14-digit Wayback timestamp. Defaults to `ARCHIVE_TIME`. |

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
| `500` | Upstream fetch failed |

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

## Deployment (Google Cloud Run)

TLS and WSS termination are handled by Cloud Run — the container receives plain HTTP.

**One-time setup:**

```bash
./setup2.sh   # creates GCP service account and IAM bindings for GitHub Actions
```

**Deploy:**

```bash
./deploy.sh         # deploys using .env
./deploy.sh prod    # deploys using .env.prod
```

Or push to `main` — the GitHub Actions workflow triggers automatically.

**GitHub secrets required:**

| Secret | Description |
|---|---|
| `GCP_SA_KEY` | Service account JSON key |
| `GCP_PROJECT_ID` | GCP project ID |
| `GCP_CACHE_BUCKET` | GCS bucket name for shared cache |
| `ENV_PROD` | Full contents of `.env.prod` |

The shared cache is a GCS bucket mounted at `/app/cache` via GCS FUSE, so all Cloud Run instances share cached responses across restarts and scale-out events.

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
