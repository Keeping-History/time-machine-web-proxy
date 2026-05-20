# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### BREAKING CHANGES

- **Cache invalidation**: the SHA256+JSON entries written by previous versions
  are no longer read. The new v2 layout lives under
  `${CACHE_DIR}/v2/<time>/<host>/<path>` and is populated by the
  `wayback-machine-downloader` job worker. Operators upgrading should expect a
  cold cache on first deploy.
- **Removed environment variables**: `ARCHIVE_RATE_PER_SEC`, `ARCHIVE_BURST`,
  `ARCHIVE_MAX_RETRIES`, `ARCHIVE_MAX_CONCURRENT`, `URL_PREFIX`. BullMQ now
  owns rate limiting and retry; the archive base URL is fixed to
  `https://web.archive.org/`.
- **Cache management API**: `DELETE /cache?type=...` returns `410 Gone`. The
  new v2 layout has no per-entry MIME metadata, so the type filter cannot be
  implemented without an extension walk. `DELETE /cache?domain=...` still
  works (host directory match, supports `*.example.com`).

### Added

- Redis-backed BullMQ job queue for foreground (exact-URL) and background
  (domain-crawl) Wayback fetches.
- Outbound HTTP proxy support via `OUTBOUND_PROXY_URL` (ProxyMesh / Squid;
  basic-auth or IP-auth). Sets `undici` global dispatcher at startup.
- Per-host 24h crawl budget plus CDX preflight prevent unbounded domain
  crawls.
- `docs/deployment.md` covering Memorystore, VPC Connector, Cloud Run flags,
  and ProxyMesh setup.
- `docker-compose.yml` now ships a local Redis service.

### Changed

- Cache layer rewritten as a read-only lookup over the downloader's native
  tree layout (`${CACHE_DIR}/v2/<time>/<host>/<path>`) with path-traversal
  protection.
- Cloud Build `gcloud run deploy` step adds `--vpc-connector`,
  `--vpc-egress=private-ranges-only`, `--set-secrets` for Redis and outbound
  proxy passwords, `--min-instances=1`, and `--no-cpu-throttling` so the
  in-process worker stays CPU-allocated when idle.

### Removed

- `WaybackClient`, `ArchiveRequestQueue`, `arcUrl`, and the prefetch
  url-rewriter helpers (`collectWaybackResourceUrls`,
  `rewriteImageUrlsFiltered`, `rewriteCssUrlsFiltered`).
