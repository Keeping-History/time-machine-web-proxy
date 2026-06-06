# Cache migration notes — local Docker → GCS

Seeding the production GCS-backed cache from a running local Docker image is supported. The same code writes both environments, so the on-disk layout is identical:

```
<CACHE_DIR>/v2/<14-digit-ts>/<hostname>/...content files...
<CACHE_DIR>/v2/<14-digit-ts>/<hostname>/.resolved-time
<CACHE_DIR>/v2/<14-digit-ts>/<hostname>/.notfound/<sha-of-url>
<CACHE_DIR>/v2/<14-digit-ts>/<hostname>/.content-types/<sha-of-url>
```

- Local: `CACHE_DIR=/app/cache` → docker volume `timemachine-cache` (or whatever `HOST_CACHE_DIR` is set to in `.env`).
- Prod: same `/app/cache`, mounted on the GCS bucket `tm-cache-723408812472` via GCS FUSE.

Once the bytes land in the bucket under the `v2/...` prefix, `cache.lookup()` finds them and serves HITs immediately — no worker/Redis state needed.

## Caveats before uploading

### 1. Get at the bytes first

If the local container runs against the default named volume, the files aren't on the host filesystem. Pick one:

- `docker cp <container>:/app/cache ./cache-seed`
- `docker volume inspect timemachine-cache` to find the host path and copy from there
- Restart with `HOST_CACHE_DIR=./cache` as a bind mount so files land directly on disk

### 2. Exclude `*.tmp`

`writeFile` does `write-to-tmp → rename`. A half-written `.tmp` is invisible to `lookup()` but still wastes bytes. Filter them out with `--exclude='*.tmp'`.

### 3. mtimes get reset on upload

`src/services/cache.ts:124` and `:147` use `stat.mtimeMs` to expire two kinds of sentinels:

- tentative 404 (1h TTL)
- permanent 404 (`NOT_FOUND_TTL_DAYS`, default in `config.ts`)

GCS object metadata does not preserve source mtime unless explicitly set via custom metadata. After seeding, every sentinel looks freshly written — URLs that were 404 locally stay 404 in prod for the full TTL window starting from upload, not from the original miss. Usually fine. For a clean slate, exclude `.notfound/` entirely.

### 4. Bull/Redis is separate

The seed only moves the content layer. No queue migration needed — BullMQ state lives in Redis and is recreated per environment.

### 5. GCS FUSE has no atomic rename

Irrelevant for a one-shot seed (you upload flat files via `gcloud storage cp` / `gsutil rsync`, never exercising the write path). Worth knowing if you ever shell into the prod container and write directly — partial visibility windows are possible there.

## Recommended command

Adjust the source path. The second `--exclude` drops the negative cache; remove it if you want to keep 404 sentinels (and accept the TTL reset described above).

```sh
gcloud storage rsync ./cache-seed/v2 gs://tm-cache-723408812472/v2 \
  --recursive --exclude='\.tmp$' --exclude='\.notfound/'
```
