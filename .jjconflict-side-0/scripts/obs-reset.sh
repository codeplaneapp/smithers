#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/observability/docker-compose.otel.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

DATA_DIR="$ROOT_DIR/observability/data"

echo "[obs-reset] bringing stack down and removing volumes..."
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans || true

echo "[obs-reset] resetting local data dirs..."
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"/loki "$DATA_DIR"/tempo "$DATA_DIR"/prometheus "$DATA_DIR"/grafana
chmod -R 0777 "$DATA_DIR"

echo "[obs-reset] starting fresh stack..."
docker compose -f "$COMPOSE_FILE" up -d

echo "[obs-reset] waiting for health..."
"$ROOT_DIR/scripts/obs-wait-healthy.sh"

echo "[obs-reset] stack is healthy"
