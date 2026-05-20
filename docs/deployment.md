# Deployment Guide — Cloud Run + Memorystore + ProxyMesh

This guide covers the production deployment shape for `time-machine-web-proxy`.
The service runs as a single Cloud Run container that hosts both the HTTP/WS
handler and the in-process BullMQ worker. The worker requires Redis
(Memorystore) and reaches it through a Serverless VPC Connector. Optional
outbound HTTP proxying (ProxyMesh) routes Wayback fetches through a stable
egress IP.

Approximate monthly cost for a single-region production deployment:

| Component | Cost (USD / mo) |
|---|---|
| Memorystore for Redis (Basic 1GB) | ~$36 |
| Serverless VPC Connector (smallest e2-micro) | ~$10 |
| Cloud Run, 1 always-on instance (1 vCPU / 512 MiB) | ~$10 – $15 |
| GCS bucket (cache) | usage-dependent, typically < $5 |
| ProxyMesh (optional) | per ProxyMesh plan |

---

## 1. Memorystore for Redis

Provision a Basic-tier instance with AUTH enabled. Basic is sufficient — the
worker tolerates restarts because jobs are persisted in Redis and BullMQ
retries on failure.

```bash
gcloud redis instances create tm-redis \
  --size=1 \
  --region=us-central1 \
  --redis-version=redis_7_0 \
  --tier=basic \
  --enable-auth \
  --network=default
```

After provisioning, capture the host and AUTH string:

```bash
gcloud redis instances describe tm-redis --region=us-central1 \
  --format='value(host)'
# 10.x.y.z

gcloud redis instances get-auth-string tm-redis --region=us-central1
# <password>
```

Store the password in Secret Manager (see Section 4).

The `REDIS_URL` env var injected into Cloud Run must be the fully-formed
ioredis connection URL, with the AUTH password embedded:

```
redis://default:<password>@10.x.y.z:6379
```

The application reads `REDIS_URL` verbatim — there is no `${REDIS_PASSWORD}`
substitution in code. Two ways to inject it:

- **Recommended — store the full URL as its own Secret Manager secret** so the
  password never lives on disk. Create a `redis-url` secret containing the
  full `redis://default:<password>@host:port` value, then add
  `REDIS_URL=redis-url:latest` to the `--set-secrets` flag in
  `cloudbuild.yaml`. The `REDIS_PASSWORD` env injected separately is unused
  by the app and can be dropped if you take this route.
- **Quick path — inline the URL in `.env.prod`** (the file is gitignored, but
  the password is in plaintext on disk and in the build environment).

---

## 2. Serverless VPC Access Connector

Cloud Run instances do not have direct network access to Memorystore's private
IP. A Serverless VPC Connector bridges the two.

```bash
gcloud compute networks vpc-access connectors create tm-connector \
  --region=us-central1 \
  --network=default \
  --range=10.8.0.0/28 \
  --min-instances=2 \
  --max-instances=3 \
  --machine-type=e2-micro
```

The `--range` must be a /28 block that does not overlap any existing subnet.
The smallest connector (`e2-micro`, 2 instances) costs roughly $10/mo and is
sufficient for moderate throughput (~200 Mbps).

Pass the connector name to `cloudbuild.yaml`:

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_VPC_CONNECTOR=tm-connector,COMMIT_SHA=$(git rev-parse --short HEAD)
```

Or update the default in `cloudbuild.yaml`:

```yaml
substitutions:
  _VPC_CONNECTOR: tm-connector
```

The deploy step adds:

- `--vpc-connector=$_VPC_CONNECTOR`
- `--vpc-egress=private-ranges-only`

`private-ranges-only` sends RFC1918 traffic (Memorystore) through the
connector while leaving public traffic (Wayback, ProxyMesh) on the default
egress path. The alternative — `all-traffic` — routes everything through the
connector and tends to be slower and more expensive for public fetches.

---

## 3. Cloud Run flags

The `cloudbuild.yaml` deploy step sets these flags. They are documented here
because they differ from typical request-only Cloud Run services.

| Flag | Why |
|---|---|
| `--min-instances=1` | The BullMQ worker runs in the same process as the HTTP handler. With `min-instances=0`, the service scales to zero and the worker disappears between requests, leaving queued jobs to stall. |
| `--no-cpu-throttling` | Default Cloud Run throttles CPU when no HTTP request is active. Workers stall under throttling. `--no-cpu-throttling` keeps the CPU allocated, which combined with `--min-instances=1` gives the worker a continuous execution environment. This is the 2026 flag name; the older `--cpu-always-allocated` is deprecated. |
| `--execution-environment=gen2` | Required for GCS volume mounts (the cache). |
| `--session-affinity` | Keeps WebSocket connections on the same instance for their full lifetime. |
| `--timeout=3600` | Maximum supported by Cloud Run; allows long-lived WebSocket connections. |
| `--memory=512Mi` | Minimum for the worker. Increase if `wayback-machine-downloader` is concurrent on large pages. |

---

## 4. Secret Manager

Create the secrets referenced by `cloudbuild.yaml` (`--set-secrets`):

```bash
# Full Redis connection URL (host + AUTH baked in). cloudbuild.yaml injects
# this verbatim as REDIS_URL; the app reads it directly.
REDIS_HOST=$(gcloud redis instances describe tm-redis --region=us-central1 --format='value(host)')
REDIS_AUTH=$(gcloud redis instances get-auth-string tm-redis --region=us-central1 --format='value(authString)')
printf '%s' "redis://default:${REDIS_AUTH}@${REDIS_HOST}:6379" \
  | gcloud secrets create redis-url --replication-policy=automatic --data-file=-

# Outbound proxy password (optional — only needed for Basic-auth proxies)
gcloud secrets create outbound-proxy-password --replication-policy=automatic
echo -n "<proxymesh-or-squid-password>" \
  | gcloud secrets versions add outbound-proxy-password --data-file=-

# Docker Hub token (already used by the build step)
gcloud secrets create dockerhub-token --replication-policy=automatic
echo -n "<docker-hub-pat>" \
  | gcloud secrets versions add dockerhub-token --data-file=-
```

`infra-setup.sh` also writes a `redis-password` secret containing the AUTH
string alone. That secret is unused by the Cloud Run deploy (which consumes
`redis-url` instead) and can be left in place or deleted.

Grant the Cloud Run service account access:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for secret in redis-url outbound-proxy-password; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${SA}" \
    --role=roles/secretmanager.secretAccessor
done
```

If you create a dedicated service account for the Cloud Run service, grant the
role to that account instead.

---

## 5. ProxyMesh (optional outbound proxy)

ProxyMesh is the simplest way to give Wayback a stable, well-behaved egress
identity. It also avoids the periodic IP-block events that hit free Cloud Run
egress addresses.

Sign up at <https://proxymesh.com>, then choose an endpoint hostname from the
dashboard (e.g. `us-wa-load-balancer.proxymesh.com`). Default port is `31280`.

There are two authentication modes:

1. **IP authentication** — whitelist the Cloud Run egress IPs (or NAT gateway
   IP) in the ProxyMesh dashboard. Set only `OUTBOUND_PROXY_URLS`; leave
   `OUTBOUND_PROXY_USERNAME` and `OUTBOUND_PROXY_PASSWORD` empty.

2. **Basic authentication** — set `OUTBOUND_PROXY_URLS` plus the username and
   password env vars. The application URL-encodes the credentials and applies
   them to every URL in the list before passing each to `undici.ProxyAgent`.

`OUTBOUND_PROXY_URLS` is a CSV. Provide one URL for a single proxy, or two
or more URLs to rotate per outbound request. `OUTBOUND_PROXY_CHOOSER`
selects the rotation strategy (`Sequential` round-robin, the default, or
`Random`) and is ignored when only one URL is configured.

Example IP-auth setup, single proxy:

```
OUTBOUND_PROXY_URLS=http://us-wa-load-balancer.proxymesh.com:31280
OUTBOUND_PROXY_USERNAME=
OUTBOUND_PROXY_PASSWORD=
```

Example Basic-auth setup with rotation (the password ships via Secret Manager):

```
OUTBOUND_PROXY_URLS=http://us-wa.proxymesh.com:31280,http://uk.proxymesh.com:31280,http://au.proxymesh.com:31280
OUTBOUND_PROXY_CHOOSER=Random
OUTBOUND_PROXY_USERNAME=tm-prod
OUTBOUND_PROXY_PASSWORD=<from-secret-manager>
```

When a single URL is set, the startup log emits:

```
[outbound-proxy] installed host=us-wa-load-balancer.proxymesh.com:31280 auth=basic
```

When multiple URLs are set, the startup log emits:

```
[outbound-proxy] installed (rotating) hosts=[...] auth=basic chooser=random count=3
```

When only one of `OUTBOUND_PROXY_USERNAME` / `OUTBOUND_PROXY_PASSWORD` is set,
or `OUTBOUND_PROXY_CHOOSER` is anything other than `Sequential`/`Random`, or
any URL in the list is unparseable or non-http(s), the process fails fast at
startup.

---

## 6. GitHub Actions / Cloud Build

`./deploy.sh` and the GitHub Actions workflow submit the build to Cloud Build:

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_VPC_CONNECTOR=tm-connector,COMMIT_SHA=$(git rev-parse --short HEAD)
```

The trigger and substitutions are documented in the header of
`cloudbuild.yaml`. Required secrets and substitutions:

| Name | Purpose |
|---|---|
| `dockerhub-token` (Secret Manager) | Docker Hub auth |
| `redis-url` (Secret Manager) | Full Redis URL with Memorystore AUTH |
| `outbound-proxy-password` (Secret Manager) | ProxyMesh / Squid auth |
| `_VPC_CONNECTOR` (substitution) | VPC connector name |
| `_CACHE_BUCKET` (substitution) | GCS bucket for FUSE cache |

---

## 7. Smoke test

After the first deploy:

```bash
SERVICE_URL=$(gcloud run services describe time-machine-proxy \
  --region=us-central1 --format='value(status.url)')

# Foreground exact-URL fetch
curl -sS -o /dev/null -w '%{http_code}\n' \
  "${SERVICE_URL}/?url=https://example.com&time=19980101000000"

# Verify outbound proxy install (look for the startup log)
gcloud run services logs read time-machine-proxy --region=us-central1 \
  --limit=50 | grep '\[outbound-proxy\] installed'

# Verify worker is dequeuing
gcloud redis instances describe tm-redis --region=us-central1 \
  --format='value(host,port)'
# then from a VM inside the VPC:
# redis-cli -h <host> -p 6379 -a <password> LLEN tm:archive-exact:wait
```

Expected: first call returns within 60s (cold cache + Wayback latency).
Subsequent calls for the same URL+time return within 100ms (cache HIT).

---

## 8. Local development

`docker-compose up` brings the application and a local Redis up together. The
`redis` service uses `redis:7-alpine` with no AUTH (set
`REDIS_URL=redis://localhost:6379` in `.env`).

```bash
cp .env.example .env
docker compose up redis -d   # start only Redis
pnpm install
pnpm dev
```

Or run the whole stack inside Docker:

```bash
cp .env.example .env
docker compose up --build
```

The local cache lives in the named Docker volume `timemachine-cache`. Override
with `HOST_CACHE_DIR=/absolute/path` in `.env` to bind-mount.
