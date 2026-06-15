# Post-Deploy Verification

Operator checklist for verifying acceptance criteria that require a live
system. Run after Argo CD rolls out a new revision of `time-machine-web-proxy`
to the k3s cluster.

## Prerequisites

```bash
# kubeconfig for the local k3s cluster, and the app namespace
export NS=time-machine
kubectl -n "$NS" get deploy time-machine

# Port-forward the service so the checks below hit the pod directly,
# bypassing the Ingress.
kubectl -n "$NS" port-forward deploy/time-machine 8765:8765 &
SERVICE_URL="http://localhost:8765"
echo "SERVICE_URL=${SERVICE_URL}"
```

---

## Check 1 — Rollout health (correct image, pod + sidecar ready)

On k3s the in-process BullMQ worker always has CPU and reaches Redis over the
cluster network, so the old Cloud Run flags (`--no-cpu-throttling`,
`--min-instances`, VPC connector) no longer apply. Instead verify the rollout
itself landed: the live image matches the latest build and both containers
(app + `gcsfuse` sidecar) are ready.

```bash
# Argo CD considers the app Synced + Healthy
argocd app get time-machine 2>/dev/null | grep -E 'Sync Status|Health Status' || true

# Deployment fully rolled out, no old replicas lingering
kubectl -n "$NS" rollout status deploy/time-machine --timeout=60s

# Live image tag (should match the latest GHCR build / commit sha)
kubectl -n "$NS" get deploy time-machine \
  -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'

# Pod Running with the gcsfuse native sidecar (an initContainer with
# restartPolicy: Always) up and the app container Ready.
kubectl -n "$NS" get pods -l app=time-machine
kubectl -n "$NS" get pod -l app=time-machine \
  -o jsonpath='{range .items[0].status.initContainerStatuses[*]}{.name}={.ready}{"\n"}{end}{range .items[0].status.containerStatuses[*]}{.name}={.ready}{"\n"}{end}'
```

**PASS criteria:**
- Argo CD: `Synced` and `Healthy`.
- `rollout status` reports the deployment successfully rolled out.
- The app image tag matches the expected commit SHA (or `latest`).
- Pod is `Running`, the `gcsfuse` sidecar and `time-machine` container both
  report `ready=true` (no `CrashLoopBackOff`, no stuck sidecar).

If the pod is up but the `gcsfuse` sidecar is not Ready, the cache mount
failed — check the sidecar logs and the GCS SA key in `time-machine-secrets`:

```bash
kubectl -n "$NS" logs deploy/time-machine -c gcsfuse --tail=50
```

---

## Check 2 — Uncached foreground fetch under 60s (plan AC #4)

Pick a URL the cache has not seen yet. Wayback's snapshot speed is the main
variable; this check confirms our wrapper does not add unbounded overhead.

```bash
# Pick a URL not yet cached — vary the time parameter to bust the cache
TARGET="https://example.com/"
TIME="20180101000000"
URL="${SERVICE_URL}/?url=$(printf '%s' "$TARGET" | jq -sRr @uri)&time=${TIME}"

# Warm DNS, then time the fetch
curl -sS -o /dev/null "${URL}" -w "%{http_code}\n" > /dev/null
time curl -sS -o /tmp/tm-fetch.body -D /tmp/tm-fetch.headers "${URL}" \
  -w 'http_code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total}\n'
```

**PASS criteria:**
- `http_code=200`
- `total` ≤ 60s
- Response headers include `X-Cache: MISS` on first request, `X-Cache: HIT` on retries

If `total` exceeds 60s — or the fetch hangs with `UND_ERR_CONNECT_TIMEOUT` —
suspect outbound egress: check the **pod MTU (must be 1280 on the Tailscale
k3s cluster)** and outbound proxy health. See `docs/deployment.md` §1 and §5.
Otherwise check the app logs for worker stalls or 429 throttling from Wayback:

```bash
kubectl -n "$NS" logs deploy/time-machine -c time-machine --tail=100
```

---

## Check 3 — Cached foreground fetch under 100ms (plan AC #5)

After Check 2, the same `(url, time)` pair should be cached. The second fetch
is a pure file read from the GCS FUSE mount.

```bash
# Re-run the same URL — should hit the v2 cache
time curl -sS -o /dev/null "${URL}" -w 'http_code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total} cache=%{header_x_cache}\n'
```

**PASS criteria:**
- `cache=HIT`
- `total` ≤ 100ms (allow more headroom for the first read after a pod restart,
  while gcsfuse warms its metadata cache)

If the second fetch shows `cache=MISS`, the GCS FUSE mount may have lost the
write — check for `fs.access`/write failures in the app logs and confirm the
`gcsfuse` sidecar is Ready (Check 1).

---

## Check 4 — Domain crawl enqueued exactly once after HTML hit (plan AC #6)

A successful HTML cache miss should fire one fire-and-forget `archive-crawl`
job for the host. Re-fetching the same URL must NOT enqueue a second crawl
(per-host 24h budget gates it). Redis is in-cluster, so inspect it via `exec`:

```bash
kubectl -n "$NS" exec deploy/redis -- redis-cli LLEN tm:archive-crawl:wait
kubectl -n "$NS" exec deploy/redis -- redis-cli GET  tm:crawl:budget:example.com
kubectl -n "$NS" exec deploy/redis -- redis-cli TTL  tm:crawl:budget:example.com
```

**PASS criteria:**
- `LLEN tm:archive-crawl:wait` returns 1 (or 0 if the worker already picked it
  up) — NOT 2+.
- `GET tm:crawl:budget:example.com` returns `"1"` with `TTL` ≤ 86400 (set by
  `SET NX EX`).
- Re-fetching the same URL while the budget key is present does NOT increase
  `LLEN`.

If `LLEN` shows duplicates, the deterministic `jobId` (sha256 of `host|time`)
may have failed to dedupe — investigate the producer in
`src/clients/archive-job-client.ts:18`.

---

## Check 5 — Outbound proxy install (plan AC, log line)

Only relevant when `OUTBOUND_PROXY_URLS` is configured.

```bash
kubectl -n "$NS" logs deploy/time-machine -c time-machine \
  | grep '\[outbound-proxy\] installed'
```

**PASS criteria:**
- For a single URL, returns `[outbound-proxy] installed` with `host=<proxy>` and `auth=basic|ip`.
- For multiple URLs, returns `[outbound-proxy] installed (rotating)` with `hosts=[...]`, `chooser=sequential|random`, and `count=<N>`.
- The password value does NOT appear in any log line:
  ```bash
  kubectl -n "$NS" logs deploy/time-machine -c time-machine --tail=500 \
    | grep -iE 'password|secret' | wc -l
  ```
  Must return `0`.

If the log line is missing but `OUTBOUND_PROXY_URLS` is set in the ConfigMap,
the install function may be silently no-op'ing — investigate
`src/lib/outbound-proxy.ts`.

---

## Failure escalation

If any check fails:
1. Roll back the workload: `kubectl -n "$NS" rollout undo deploy/time-machine`
   (or, in Argo CD, roll back to the previous synced revision:
   `argocd app rollback time-machine`).
2. Capture logs:
   `kubectl -n "$NS" logs deploy/time-machine -c time-machine --tail=200 --previous`
   (drop `--previous` if the pod did not restart).
3. Check recent events: `kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -20`
4. File an incident; refer to `plans/redis-queue-wayback-downloader.md` for
   architectural context.
