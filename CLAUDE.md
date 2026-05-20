# CLAUDE.md — Time Machine Web Proxy

## Project overview

A single-file Node.js proxy server (`timemachine.ts`) that fetches archived pages from the Wayback Machine and serves them locally with toolbar stripped and URLs rewritten. Deployed to Google Cloud Run via Cloud Build.

## Stack

- **Runtime:** Node.js 22
- **Language:** TypeScript (single file: `timemachine.ts`)
- **Bundler:** esbuild (`npm run build` → `dist/timemachine.js`)
- **Type-check only:** `npm run typecheck` (no emit)
- **Container:** Docker, multi-stage build (`node:22-bookworm` → `node:22-bookworm-slim`)
- **Deployment:** Google Cloud Run (gen2) via Cloud Build (`cloudbuild.yaml`)
- **CI/CD:** GitHub Actions (`.github/workflows/deploy.yml`) triggers Cloud Build

## Key files

| File | Purpose |
|---|---|
| `timemachine.ts` | Entire application — do not split without discussion |
| `Dockerfile` | Multi-stage build; runtime image has no node_modules |
| `cloudbuild.yaml` | Build, push to Artifact Registry + Docker Hub, deploy to Cloud Run |
| `.github/workflows/deploy.yml` | Triggers Cloud Build on push to main |
| `deploy.sh` | Local deploy script; sources `.env` or `.env.prod` |
| `setup2.sh` | One-time GCP IAM setup for GitHub Actions |
| `.gcloudignore` | Inherits `.gitignore` but allows `.env.prod` through to Cloud Build |

## Environment

- `.env` — local development
- `.env.prod` — production (gitignored; written from `ENV_PROD` GitHub secret in CI)
- `PROXY_BASE_URL` must be set to the public URL when running behind a reverse proxy or on Cloud Run
- `LISTENER` must be `0.0.0.0` on Cloud Run (Cloud Build deploy overrides this via sed in the yaml conversion step)

## Deployment notes

- Cloud Run terminates TLS/WSS; the container receives plain HTTP
- Shared cache: GCS bucket `tm-cache-723408812472` mounted at `/app/cache` via GCS FUSE
- `--env-vars-file` requires YAML format; `cloudbuild.yaml` converts `.env.prod` on the fly with awk/sed
- `COMMIT_SHA` must be passed explicitly to `gcloud builds submit` (not auto-populated outside triggers)
- Docker Hub push uses `dockerhub-token` from Secret Manager

## Rules

- Do not modify `timemachine.ts` logic without reading the full file first
- Do not add dependencies without discussion — the bundle must stay lean
- Do not commit `.env`, `.env.prod`, or `key.json`
- Never push or create PRs without explicit instruction

@.claude/wiz-claude.md
