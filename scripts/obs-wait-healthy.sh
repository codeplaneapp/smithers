#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/observability/docker-compose.otel.yml"
TIMEOUT_SECONDS="${1:-240}"
START_TS=$(date +%s)

services=(loki tempo otel-collector prometheus grafana)

status_of() {
  local container=$1
  docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo "missing"
}

container_name() {
  local service=$1
  docker compose -f "$COMPOSE_FILE" ps -q "$service" | head -n 1
}

echo "[obs-wait] timeout=${TIMEOUT_SECONDS}s"

while true; do
  all_ready=1
  for service in "${services[@]}"; do
    cid=$(container_name "$service")
    if [[ -z "$cid" ]]; then
      echo "[obs-wait] $service: missing"
      all_ready=0
      continue
    fi
    state=$(status_of "$cid")
    echo "[obs-wait] $service: $state"
    if [[ "$state" != "healthy" && "$state" != "running" ]]; then
      all_ready=0
    fi
    if [[ "$service" != "otel-collector" && "$state" != "healthy" ]]; then
      all_ready=0
    fi
  done

  if [[ "$all_ready" == "1" ]]; then
    break
  fi

  now=$(date +%s)
  if (( now - START_TS >= TIMEOUT_SECONDS )); then
    echo "[obs-wait] timed out waiting for health" >&2
    docker compose -f "$COMPOSE_FILE" ps >&2 || true
    exit 1
  fi

  sleep 5
  echo
 done

echo "[obs-wait] endpoint checks"
curl --max-time 10 -fsS http://localhost:3100/ready >/dev/null
curl --max-time 10 -fsS http://localhost:9090/-/ready >/dev/null
curl --max-time 20 -fsS http://localhost:3001/api/health >/dev/null

# Tempo can report not-ready briefly even when query/search already works, so allow retries.
tempo_ready=0
for _ in $(seq 1 12); do
  if curl --max-time 10 -fsS http://localhost:3200/ready >/dev/null; then
    tempo_ready=1
    break
  fi
  sleep 5
done

if [[ "$tempo_ready" != "1" ]]; then
  echo "[obs-wait] tempo never became ready" >&2
  exit 1
fi

echo "[obs-wait] healthy"
