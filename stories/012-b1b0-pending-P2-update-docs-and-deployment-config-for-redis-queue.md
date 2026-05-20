---
id: "012-b1b0"
title: "Update docs and deployment config for Redis queue"
status: pending
priority: P2
type: chore
created: 2026-05-20T17:11:02.460Z
updated: 2026-05-20T17:11:02.460Z
dependencies: []
plan: "plans/redis-queue-wayback-downloader.md"
plan_step: "Step 11"
---

# Update docs and deployment config for Redis queue

## Problem Statement

README env table, CHANGELOG, cloudbuild.yaml, and docker-compose.yml must reflect new env vars and infrastructure requirements.

## Acceptance Criteria

- [ ] README.md env table removes old archive knobs, adds REDIS_URL, BULLMQ_PREFIX, DOMAIN_CRAWL_ENABLED, WORKER_CONCURRENCY, WORKER_RATE_LIMIT_PER_SEC, DOWNLOADER_THREADS_COUNT, OUTBOUND_PROXY_* vars
- [ ] CHANGELOG.md notes v2 cache invalidation breaking change
- [ ] cloudbuild.yaml adds --vpc-connector, --set-secrets=REDIS_PASSWORD, --min-instances=1, --no-cpu-throttling to gcloud run deploy
- [ ] docker-compose.yml adds Redis service for local dev
- [ ] docs/deployment.md created documenting Memorystore + VPC Connector setup
- [ ] grep -rn "URL_PREFIX|ARCHIVE_RATE_PER_SEC" . returns zero hits in non-archived files

## Work Log

