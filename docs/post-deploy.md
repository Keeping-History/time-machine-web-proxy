# Post-Deploy Verification

Operator checklist for verifying acceptance criteria that require a live system. Run after every Cloud Run deploy of `time-machine-web-proxy`.

## Prerequisites

```bash
# Authenticated gcloud session
gcloud auth login
gcloud config set project <YOUR_PROJECT_ID>
gcloud config set run/region <YOUR_REGION>

# Service URL (set once per deploy)
SERVICE_URL=$(gcloud run services describe time-machine-web-proxy --format='value(status.url)')
echo "SERVICE_URL=${SERVICE_URL}"

# Redis connection (for inspector checks below)
gcloud redis instances describe <MEMORYSTORE_INSTANCE> --format='value(host,port)'
```

---

## Check 1 — Cloud Run flags (plan AC #16)

The in-process BullMQ worker requires CPU during request lulls. Verify the deploy applied the required flags.

```bash
gcloud run services describe time-machine-web-proxy \
  --format='json' \
  | jq '{
      minInstances: .spec.template.metadata.annotations."autoscaling.knative.dev/minScale",
      cpuThrottling: .spec.template.metadata.annotations."run.googleapis.com/cpu-throttling",
      vpcConnector: .spec.template.metadata.annotations."run.googleapis.com/vpc-access-connector",
      vpcEgress:    .spec.template.metadata.annotations."run.googleapis.com/vpc-access-egress"
    }'
```

**PASS criteria:**
- `minInstances` is `"1"`
- `cpuThrottling` is `"false"` (i.e. `--no-cpu-throttling` was applied)
- `vpcConnector` is a non-null connector name (required to reach Memorystore)
- `vpcEgress` is `"private-ranges-only"`

If any field is missing, the deploy did not apply the flags — re-run `gcloud run deploy` with the missing arguments, or update `cloudbuild.yaml`.

---

## Check 2 — Uncached foreground fetch under 60s (plan AC #4)

Pick a URL the cache has not seen yet. Wayback's snapshot speed is the main variable; this check confirms our wrapper does not add unbounded overhead.

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

If `total` exceeds 60s, check `gcloud logging read` for worker stalls or 429 throttling on the Wayback side.

---

## Check 3 — Cached foreground fetch under 100ms (plan AC #5)

After Check 2, the same `(url, time)` pair should be cached. The second fetch is a pure file read; the budget is generous to accommodate cold container starts.

```bash
# Re-run the same URL — should hit the v2 cache
time curl -sS -o /dev/null "${URL}" -w 'http_code=%{http_code} ttfb=%{time_starttransfer} total=%{time_total} cache=%{header_x_cache}\n'
```

**PASS criteria:**
- `cache=HIT`
- `total` ≤ 100ms with a warm Cloud Run instance (multiply by 2–3× during cold start)

If the second fetch shows `cache=MISS`, GCS FUSE may have lost the write — check `fs.access` failures in `gcloud logging read` and confirm the cache bucket is correctly mounted.

---

## Check 4 — Domain crawl enqueued exactly once after HTML hit (plan AC #6)

A successful HTML cache miss should fire one fire-and-forget `archive-crawl` job for the host. Re-fetching the same URL must NOT enqueue a second crawl (per-host 24h budget gates it).

```bash
# Read the Redis password from Secret Manager
REDIS_PASS=$(gcloud secrets versions access latest --secret=redis-password)
REDIS_HOST=$(gcloud redis instances describe <MEMORYSTORE_INSTANCE> --format='value(host)')

# Run from a VPC-attached instance (Memorystore is private IP) — e.g.
# a small Compute Engine VM in the same VPC, or use Cloud Shell with
# the VPC connector enabled.
redis-cli -h "${REDIS_HOST}" -a "${REDIS_PASS}" --no-auth-warning \
  LLEN tm:archive-crawl:wait
redis-cli -h "${REDIS_HOST}" -a "${REDIS_PASS}" --no-auth-warning \
  GET tm:crawl:budget:example.com
```

**PASS criteria:**
- `LLEN tm:archive-crawl:wait` returns 1 (or 0 if the worker already picked it up) — NOT 2+.
- `GET tm:crawl:budget:example.com` returns `"1"` with TTL ≤ 86400 (set by `SET NX EX`).
- Re-fetching the same URL while the budget key is present does NOT increase `LLEN`.

If `LLEN` shows duplicates, the deterministic `jobId` (sha256 of `host|time`) may have failed to dedupe — investigate the producer in `src/clients/archive-job-client.ts:18`.

---

## Check 5 — Outbound proxy install (plan AC, log line)

Only relevant when `OUTBOUND_PROXY_URL` is configured.

```bash
gcloud logging read \
  'resource.type=cloud_run_revision
   AND resource.labels.service_name=time-machine-web-proxy
   AND textPayload:"[outbound-proxy] installed"' \
  --limit=1 --format='value(textPayload)'
```

**PASS criteria:**
- Returns a line like `[outbound-proxy] installed` with `host=<proxy>` and `auth=basic|ip`.
- The password value does NOT appear in any log line:
  ```bash
  gcloud logging read 'resource.type=cloud_run_revision' --limit=200 --format=json \
    | jq '[.[] | .textPayload // ""] | map(select(test("password|secret"; "i"))) | length'
  ```
  Must return `0`.

If the log line is missing but `OUTBOUND_PROXY_URL` is set in the revision env, the install function may be silently no-op'ing — investigate `src/lib/outbound-proxy.ts`.

---

## Failure escalation

If any check fails:
1. Roll back: `gcloud run services update-traffic time-machine-web-proxy --to-revisions=<previous-revision>=100`
2. Capture logs: `gcloud logging read 'resource.type=cloud_run_revision AND severity>=WARNING' --limit=100`
3. File an incident; refer to `plans/redis-queue-wayback-downloader.md` for architectural context.
