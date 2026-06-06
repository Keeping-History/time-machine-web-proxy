# Local observability

Self-hosted log search and analysis is served by a SigNoz stack vendored
under `deploy/signoz/` and pulled into the project's `docker-compose.yml`
via `include:`. A small OTel Collector sidecar (`pino-collector`) bridges
Docker's fluentd log driver into SigNoz's OTLP receiver. The application
is not modified — pino keeps writing JSON to stdout.

## Bring it up

```sh
docker compose up -d
```

That's it. First boot of SigNoz takes ~2 minutes for ClickHouse migrations.
Once `docker compose ps` shows `signoz-clickhouse` and `signoz` healthy:

- **SigNoz UI:** <http://localhost:8080>
- **Timemachine:** <http://localhost:${TIMEMACHINE_PORT:-8765}>
- **BullBoard:** <http://localhost:3008>

Open SigNoz → Logs to query. Useful starter filters:

| Goal | Filter |
|---|---|
| Errors from timemachine | `service.name = timemachine AND severity_text = ERROR` |
| Upstream failures | `body =~ "Upstream request failed"` |
| Slow archive jobs | `attributes["durationMs"] > 5000` |

## How the pipeline fits together

```
timemachine ──stdout(pino JSON)──► docker fluentd driver
                                         │  (tcp localhost:24224)
                                         ▼
                                   pino-collector  ─OTLP──► signoz/otel-collector
                                  (transform/pino)         (clickhouse)
```

The OTTL `transform/pino` processor in `deploy/pino-collector-config.yaml`
parses the pino JSON body, maps numeric `level` 10/20/30/40/50/60 onto OTel
TRACE/DEBUG/INFO/WARN/ERROR/FATAL, lifts `time` and `msg`, and merges the
rest as attributes.

## Configuration knobs

`.env` (or shell):

| Var | Default | Purpose |
|---|---|---|
| `SIGNOZ_OTLP_ENDPOINT` | `otel-collector:4317` | Where pino-collector ships logs. Override if pointing at an external SigNoz. |

## Upgrading SigNoz

The vendored configs in `deploy/signoz/` snapshot the upstream files. To
refresh against a newer SigNoz release:

```sh
BASE=https://raw.githubusercontent.com/SigNoz/signoz/main/deploy
curl -sfo deploy/signoz/docker/docker-compose.yaml          $BASE/docker/docker-compose.yaml
curl -sfo deploy/signoz/docker/otel-collector-config.yaml   $BASE/docker/otel-collector-config.yaml
curl -sfo deploy/signoz/common/clickhouse/config.xml        $BASE/common/clickhouse/config.xml
curl -sfo deploy/signoz/common/clickhouse/users.xml         $BASE/common/clickhouse/users.xml
curl -sfo deploy/signoz/common/clickhouse/custom-function.xml $BASE/common/clickhouse/custom-function.xml
curl -sfo deploy/signoz/common/clickhouse/cluster.xml       $BASE/common/clickhouse/cluster.xml
curl -sfo deploy/signoz/common/signoz/otel-collector-opamp-config.yaml $BASE/common/signoz/otel-collector-opamp-config.yaml
```

Then `docker compose pull && docker compose up -d`.

## Troubleshooting

- **No logs in SigNoz:** confirm `docker compose ps pino-collector signoz-otel-collector`
  both show `running`, then check `docker compose logs pino-collector` for
  `failed to connect` errors. Until SigNoz's collector is healthy
  pino-collector buffers in its sending queue. The compose file gates
  pino-collector on `signoz: service_healthy` precisely because gRPC's DNS
  resolver caches initial "no such host" failures and won't re-resolve
  without a process restart — without the gate, the first
  `docker compose up` silently drops logs until you manually restart
  pino-collector.
- **`timemachine` won't start:** Docker's fluentd driver refuses a container
  if the address is unreachable when async mode is off. This repo sets
  `fluentd-async: "true"`, so timemachine boots even if pino-collector is
  down — lines buffer in the daemon and flush on reconnect.
- **Logs appear unparsed (body is the raw JSON string):** the
  `transform/pino` processor only parses `log.body` when it's a JSON string
  matching `^\{`. If Docker's log-driver wrapper shape changes, the OTTL
  statements in `deploy/pino-collector-config.yaml` need to follow.
- **ClickHouse fails to start (low memory):** SigNoz's stack wants ~4 GB
  RAM total. On constrained machines, raise Docker Desktop's memory limit.
