#!/usr/bin/env bash

set -euo pipefail

PLUE_DIR="${PLUE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/../plue}"
PLUE_API_BASE_URL="${PLUE_API_BASE_URL:-http://127.0.0.1:4000}"
PLUE_HEALTH_URL="${PLUE_API_BASE_URL}/api/health"

usage() {
  echo "usage: $0 [down|status]" >&2
}

require_plue_dir() {
  if [[ ! -d "$PLUE_DIR" ]]; then
    echo "error: PLUE_DIR=$PLUE_DIR does not exist." >&2
    exit 2
  fi
}

compose() {
  (
    cd "$PLUE_DIR"
    docker compose "$@"
  )
}

wait_for_health() {
  for _ in $(seq 1 180); do
    if curl -fsS --max-time 2 "$PLUE_HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "error: Plue /api/health did not respond at $PLUE_HEALTH_URL within 180s." >&2
  return 1
}

require_plue_dir

case "${1:-up}" in
  up)
    echo "[plue-up] Bringing up Plue stack from $PLUE_DIR ..."
    compose up -d postgres migrate seed repo-host api || exit 3
    echo "[plue-up] Waiting for $PLUE_HEALTH_URL ..."
    wait_for_health || exit 4
    echo "[plue-up] Ready."
    sleep infinity 2>/dev/null &
    probe_pid="$!"
    sleep 0.1
    if kill -0 "$probe_pid" 2>/dev/null; then
      kill "$probe_pid" 2>/dev/null || true
      wait "$probe_pid" 2>/dev/null || true
      exec sleep infinity
    fi
    wait "$probe_pid" 2>/dev/null || true
    if command -v gsleep >/dev/null 2>&1; then
      exec gsleep infinity
    fi
    exec bash -c 'while :; do sleep 86400; done'
    ;;
  down)
    compose down || exit 5
    ;;
  status)
    compose ps || exit 6
    ;;
  *)
    usage
    exit 64
    ;;
esac
