# Deployment Guide — k3s + Argo CD + GHCR

This guide covers the production deployment shape for `time-machine-web-proxy`.
The service runs as a single Deployment pod that hosts both the HTTP/WS handler
and the in-process BullMQ worker. The worker needs Redis (an in-cluster
Service) and a shared cache (a GCS bucket mounted via a `gcsfuse` sidecar).
Optional outbound HTTP proxying (ProxyMesh) routes Wayback fetches through a
stable egress IP.

Deployment is **GitOps**: this repo only builds and publishes the image.
Rollout is driven by Argo CD reconciling manifests that live in the separate
**`Keeping-History/infra`** repo. There is no manual deploy step here.

---

## Architecture

```
  push to main
       │
       ▼
 GitHub Actions (.github/workflows/build.yml)
       │  builds image, pushes tags {sha,latest}
       ▼
   GHCR  ghcr.io/keeping-history/time-machine-web-proxy
       │
       ▼  (Argo CD Image Updater watches the registry)
 Argo CD ── reconciles ──▶ Keeping-History/infra : apps/time-machine/
       │
       ▼
   k3s cluster (2 nodes, joined over Tailscale/WireGuard)
       │
       ├─ timemachine pod
       │    ├─ app container        (envFrom: time-machine-config + time-machine-secrets)
       │    └─ gcsfuse sidecar      (mounts GCS bucket at /app/cache)
       ├─ redis Service             (BullMQ queue)
       └─ Ingress                   (TLS/WSS termination → plain HTTP to pod)
```

The cluster is **self-hosted k3s**, not GKE — there is no Memorystore, no VPC
Connector, and no Cloud Build/Cloud Run in the live path. The old GCP pipeline
artifacts (`cloudbuild.yaml`, `deploy.sh`, `.gcloudignore`) remain in-tree for
reference only.

The Deployment is pinned to **`replicas: 1`** with the `Recreate` strategy.
The BullMQ worker runs in the same process as the HTTP/WS handler and must stay
scheduled (the Cloud Run analogue was `min-instances=1` + `--no-cpu-throttling`);
scaling past one would require splitting the worker out and adding WebSocket
session affinity, and would also double-mount the single cache FUSE volume.

---

## 1. The k3s cluster

Production is a 2-node k3s cluster whose nodes are joined over a Tailscale
(WireGuard) mesh rather than a flat L2 LAN.

> **Pod MTU gotcha (important).** Because inter-node pod traffic and outbound
> internet egress traverse the WireGuard tunnel, the pod `eth0` MTU must be
> clamped to **1280**. WireGuard's encapsulation overhead means the default
> 1500-byte (or 1450 flannel) MTU causes large TLS handshake packets to be
> silently dropped — outbound HTTPS to `web.archive.org` black-holes and the
> app surfaces `UND_ERR_CONNECT_TIMEOUT` on every fetch while small requests
> appear to work. If you see connect timeouts only on TLS egress, check the
> pod MTU first. This is a cluster/CNI-level setting (k3s flannel), not part of
> this application or the `apps/time-machine/` manifests.

---

## 2. Redis

Redis runs as an in-cluster `redis:7-alpine` Deployment + Service (no AUTH
needed inside the cluster network), with `--appendonly yes` backed by a
`local-path` PVC (`redis-data`, 5Gi) so the queue survives Redis restarts. The
Deployment uses the `Recreate` strategy because the single RWO volume can't be
mounted by two pods at once. The app reaches it by Service DNS:

```
REDIS_URL=redis://redis:6379
```

`REDIS_URL` is set in the `time-machine-config` ConfigMap. The application
reads it verbatim — there is no `${REDIS_PASSWORD}` substitution in code. If
you point at an external/managed Redis with AUTH, embed the credentials in the
URL (`redis://default:<password>@host:6379`) and move the value into the
`time-machine-secrets` Secret so it is not stored in the public ConfigMap.

BullMQ persists jobs in Redis and retries on failure, so a pod restart does not
lose queued work.

---

## 3. Shared cache (GCS FUSE)

The response cache is a GCS bucket — `tm-cache-723408812472` — mounted into the
pod at `/app/cache`, so it survives pod restarts. The v2 tree lives under
`${CACHE_DIR}/v2/`.

The mount is provided by a **native sidecar** (`apps/time-machine/app.yaml`):
a `gcsfuse` container declared as an `initContainer` with
`restartPolicy: Always` (k8s 1.29+). It runs before the app container, installs
`gcsfuse` at runtime on top of `google/cloud-sdk`, and mounts the bucket onto a
shared `emptyDir` with `mountPropagation: Bidirectional` so the app container
(which mounts the same volume `HostToContainer`) sees the FUSE filesystem. The
app container only starts once the sidecar's readiness probe
(`mountpoint /app/cache`) passes. The sidecar also self-heals a stale FUSE
mount left by an ungraceful previous exit (OOMKill/SIGKILL) before remounting.

Authentication to the bucket is a GCP service-account key in its **own**
Kubernetes Secret named **`gcs-sa-key`** (key `key.json`), mounted read-only at
`/secrets/gcs` and passed to gcsfuse via `--key-file`. This is a **separate
Secret** from `time-machine-secrets` (Section 4). The bucket, the service
account, and its IAM binding are provisioned out-of-band:

```bash
kubectl create secret generic gcs-sa-key \
  --namespace time-machine \
  --from-file=key.json=/path/to/gcs-sa-key.json
```

`CACHE_DIR` defaults to `/app/cache`; keep it aligned with the sidecar mount
path. `CACHE_ENABLED=false` disables disk caching entirely (useful for
debugging cache poisoning).

---

## 4. Config & secrets

The app loads its environment via `envFrom` against two sources, both defined
in the `infra` repo:

| Source | Kind | Holds |
|---|---|---|
| `time-machine-config` | ConfigMap (`apps/time-machine/configmap.yaml`) | **non-secret** env: `ARCHIVE_TIME`, `PROXY_BASE_URL`, `LISTENER=0.0.0.0`, `REDIS_URL`, cache/worker knobs, `LOCK_TIME`, etc. Add new non-secret flags here. |
| `time-machine-secrets` | Secret (created out-of-band with `kubectl`) | `OUTBOUND_PROXY_PASSWORD`, `CACHE_CLEAR_TOKEN`, etc. Loaded into the app via `envFrom`. |

> The GCS service-account key is **not** in this Secret — it lives in its own
> `gcs-sa-key` Secret consumed by the gcsfuse sidecar (Section 3).

The `infra` repo is public, so secrets are **never** committed there — the
`time-machine-secrets` Secret is created imperatively against the cluster:

```bash
kubectl create secret generic time-machine-secrets \
  --namespace time-machine \
  --from-literal=CACHE_CLEAR_TOKEN='<token>' \
  --from-literal=OUTBOUND_PROXY_PASSWORD='<proxymesh-password>'
```

A config change rolls out automatically once it lands in `infra` and Argo CD
reconciles; a Secret change requires the pod to restart to pick up new env.

---

## 5. ProxyMesh (optional outbound proxy)

> **Current state: disabled.** In production `OUTBOUND_PROXY_URLS` is empty —
> the node reaches Wayback directly from its own IP (ProxyMesh was flapping in
> and out of rotation). `OUTBOUND_PROXY_PASSWORD` remains in
> `time-machine-secrets` but is unused while the URL list is empty. The rest of
> this section documents how to re-enable it.

ProxyMesh is the simplest way to give Wayback a stable, well-behaved egress
identity, and avoids the periodic IP-block events that hit shared/residential
egress addresses. This is **application-level** config (the same env vars work
locally and in any cluster) — it is not tied to the deployment platform.

Sign up at <https://proxymesh.com>, then choose an endpoint hostname from the
dashboard (e.g. `us-wa-load-balancer.proxymesh.com`). Default port is `31280`.

There are two authentication modes:

1. **IP authentication** — whitelist your cluster's egress IP (the Tailscale
   exit / NAT IP that Wayback sees) in the ProxyMesh dashboard. Set only
   `OUTBOUND_PROXY_URLS`; leave `OUTBOUND_PROXY_USERNAME` and
   `OUTBOUND_PROXY_PASSWORD` empty.

2. **Basic authentication** — set `OUTBOUND_PROXY_URLS` plus the username and
   password env vars. The application URL-encodes the credentials and applies
   them to every URL in the list before passing each to `undici.ProxyAgent`.

`OUTBOUND_PROXY_URLS` is a CSV. Provide one URL for a single proxy, or two
or more URLs to rotate per outbound request. `OUTBOUND_PROXY_CHOOSER`
selects the rotation strategy (`sequential` round-robin, the default, or
`random`); values are case-insensitive. Ignored when only one URL is
configured.

Example IP-auth setup, single proxy (in `time-machine-config`):

```
OUTBOUND_PROXY_URLS=http://us-wa-load-balancer.proxymesh.com:31280
OUTBOUND_PROXY_USERNAME=
OUTBOUND_PROXY_PASSWORD=
```

Example Basic-auth setup with rotation (the password ships via the Secret):

```
OUTBOUND_PROXY_URLS=http://us-wa.proxymesh.com:31280,http://uk.proxymesh.com:31280,http://au.proxymesh.com:31280
OUTBOUND_PROXY_CHOOSER=random
OUTBOUND_PROXY_USERNAME=tm-prod
OUTBOUND_PROXY_PASSWORD=<from time-machine-secrets>
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

**Startup connectivity probe.** Each configured proxy is exercised at startup
with an HTTP request to `https://web.archive.org/` (30s timeout). If every
proxy fails the probe, the process exits. If some pass and some fail, the
failed ones start in cooldown and are re-probed automatically.

**Runtime circuit breaker.** Transport errors (connect/DNS/timeout/TLS),
HTTP 407, and 502/503/504 responses through a proxy mark it failed and take
it out of rotation for `OUTBOUND_PROXY_COOLDOWN_SECONDS` (default 60s). At
cooldown expiry, the proxy is re-probed; success restores it, failure
extends the cooldown linearly (X, 2X, 3X, ...). When every proxy is
currently in cooldown, dispatch throws `no healthy proxy`. Note that
5xx-from-upstream forwarded by the proxy may produce false positives —
tune the cooldown to limit blast radius from a single Wayback hiccup.

> Reminder: when proxy egress is misbehaving, first rule out the
> **pod MTU = 1280** issue from Section 1 — a too-large MTU produces the same
> connect-timeout symptom as a dead proxy.

---

## 6. Build & rollout (GHCR + Argo CD)

There is no `gcloud builds submit` and no `./deploy.sh` in the live path.

**Build.** Pushing to `main` runs `.github/workflows/build.yml`, which builds
the multi-stage image and pushes it to GHCR as both `:<sha>` and `:latest`.
The workflow authenticates to GHCR with the run's `GITHUB_TOKEN` — there are
no GCP keys or cluster credentials in this repo.

**Rollout.** Argo CD (in the cluster) reconciles `apps/time-machine/` from the
`Keeping-History/infra` repo. Argo CD Image Updater watches GHCR and updates
the running image tag when a new build lands, so a merge to `main` flows to
production with no human step.

To deploy a code change:

```bash
git push origin main
```

To change runtime config, edit `apps/time-machine/configmap.yaml` in the
`infra` repo and let Argo CD reconcile (or `argocd app sync time-machine` to
force it).

---

## 7. Smoke test

After a rollout, verify against the pod / Service:

```bash
NS=time-machine

# Pod is running and the latest image is live
kubectl -n "$NS" get pods -l app=time-machine -o wide
kubectl -n "$NS" get deploy time-machine \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

# Foreground exact-URL fetch (port-forward to avoid Ingress in the test)
kubectl -n "$NS" port-forward deploy/time-machine 8765:8765 &
curl -sS -o /dev/null -w '%{http_code}\n' \
  "http://localhost:8765/?url=https://example.com&time=19980101000000"

# Verify outbound proxy install (when configured)
kubectl -n "$NS" logs deploy/time-machine -c time-machine \
  | grep '\[outbound-proxy\] installed'

# Verify the worker is dequeuing (exec into the redis pod)
kubectl -n "$NS" exec deploy/redis -- redis-cli LLEN tm:archive-exact:wait
```

Expected: first call returns within ~60s (cold cache + Wayback latency).
Subsequent calls for the same URL+time return within ~100ms (cache HIT served
from the GCS FUSE mount).

If outbound fetches hang and time out (`UND_ERR_CONNECT_TIMEOUT`) while the pod
is otherwise healthy, check the **pod MTU (Section 1)** and the **outbound
proxy health (Section 5)** in that order.

---

## 8. Local development

`docker compose up` brings the application and a local Redis up together (plus
the vendored SigNoz observability stack — see `docs/observability.md`). The
`redis` service uses `redis:7-alpine` with no AUTH (set
`REDIS_URL=redis://redis:6379` in `.env`).

```bash
cp .env .env.local        # adjust values as needed
docker compose up redis -d   # start only Redis
pnpm install
pnpm dev
```

Or run the whole stack inside Docker:

```bash
docker compose up --build
```

The local cache lives in the named Docker volume `timemachine-cache`. Override
with `HOST_CACHE_DIR=/absolute/path` in `.env` to bind-mount. `.env` /
`.env.prod` in this repo drive **local** runs only — production config comes
from the `time-machine-config` ConfigMap in the `infra` repo.
