# CLAUDE.md — Time Machine Web Proxy

## Project overview

A Node.js proxy server that fetches archived pages from the Wayback Machine and serves them locally with the toolbar stripped and URLs rewritten. The image is built and published to GHCR by GitHub Actions; deployment is GitOps via Argo CD on Kubernetes (manifests live in the separate `Keeping-History/infra` repo).

## Stack

- **Runtime:** Node.js 22
- **Language:** TypeScript — modular under `src/` (entry `src/index.ts`)
- **Bundler:** esbuild (`npm run build` → bundles `src/index.ts` to `dist/timemachine.js`)
- **Type-check only:** `npm run typecheck` (no emit)
- **Tests:** Jest (`npm test`)
- **Container:** Docker, multi-stage build (`node:22-bookworm` → `node:22-bookworm-slim`); built with pnpm; `CMD ["node", "timemachine.js"]`, port 8765
- **Image registry:** GHCR — `ghcr.io/keeping-history/time-machine-web-proxy:{sha,latest}`
- **CI:** `.github/workflows/build.yml` — on push to `main` (and PRs) builds the image and pushes to GHCR. No deploy, no cluster credentials, touches no manifests.
- **Deployment:** Kubernetes via Argo CD (GitOps). Argo CD Image Updater watches GHCR and rolls out new images; manifests live in `Keeping-History/infra` under `apps/time-machine/`.

## Key files

| File | Purpose |
|---|---|
| `src/index.ts` | Application entry point |
| `src/services/`, `src/lib/`, `src/models/`, `src/clients/`, `src/queue/` | Modular app (proxy, cache, url-rewriter, runtime-shim, config, archive worker, …) |
| `Dockerfile` | Multi-stage build; runtime image has no node_modules |
| `.github/workflows/build.yml` | Builds + pushes the image to GHCR on push to main |
| `cloudbuild.yaml`, `deploy.sh`, `.gcloudignore` | **Legacy** — the old Cloud Build → Cloud Run pipeline, replaced by GHCR + Argo CD. Not used by the current deploy. |

## Deployment & config

Runtime config lives in the **`Keeping-History/infra`** repo (kustomize), not here:

- `apps/time-machine/app.yaml` — Deployment (incl. a `gcsfuse` sidecar that mounts the shared GCS cache bucket at `/app/cache`) + Service. The app container loads env via `envFrom`: the `time-machine-config` ConfigMap **and** the `time-machine-secrets` Secret.
- `apps/time-machine/configmap.yaml` — `time-machine-config`: **non-secret** env (e.g. `ARCHIVE_TIME`, `PROXY_BASE_URL`, `LISTENER=0.0.0.0`, `REDIS_URL`, cache/worker knobs). Add new non-secret flags (e.g. `LOCK_TIME`) here.
- `time-machine-secrets` — a Kubernetes Secret created out-of-band with `kubectl` (this repo is public); holds `OUTBOUND_PROXY_PASSWORD`, `CACHE_CLEAR_TOKEN`, etc.

Notes:
- A config/image change rolls out automatically once it lands in `infra` (config) or GHCR (image) — there is no manual deploy step.
- `.env` / `.env.prod` in this repo are for **local** runs only; `.env.prod` no longer drives production.
- Shared cache: GCS bucket `tm-cache-723408812472` mounted at `/app/cache` via GCS FUSE.

## Rules

- Read the full file before modifying any `src/` module; the code is modular but tightly coupled (hexagonal ports in `src/models/`).
- Do not add dependencies without discussion — the bundle must stay lean.
- Do not commit `.env`, `.env.prod`, or `key.json`.
- Never push or create PRs without explicit instruction.

@.claude/wiz-claude.md
