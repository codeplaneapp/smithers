#!/usr/bin/env bash
set -euo pipefail

PORT="${SMITHERS_REAL_GATEWAY_PORT:-7342}"
HOST="${SMITHERS_REAL_GATEWAY_HOST:-127.0.0.1}"
ORIGIN="http://${HOST}:${PORT}"

if command -v curl >/dev/null 2>&1 && curl -fsS "${ORIGIN}/health" >/dev/null 2>&1; then
  if ! curl -fsS "${ORIGIN}/workflows/e2e-probe" >/dev/null 2>&1 || ! curl -fsS "${ORIGIN}/workflows/e2e-approval-probe" >/dev/null 2>&1; then
    if command -v lsof >/dev/null 2>&1; then
      while IFS= read -r pid; do
        if [[ -n "${pid}" ]]; then
          kill "${pid}" 2>/dev/null || true
        fi
      done < <(lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN || true)
      sleep 1
    fi
  fi
fi

PORT="${PORT}" HOST="${HOST}" bun ../../.smithers/gateway.ts
