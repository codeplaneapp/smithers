#!/usr/bin/env bash
# Reads the running dstack service and prints env vars for the workflow.
#
# Usage:
#   ./scripts/print-env.sh                   # prints export statements
#   source <(./scripts/print-env.sh)          # loads into current shell
#
# Requires: dstack CLI authenticated, `kimi-k2` service in `running` state.

set -euo pipefail

RUN_NAME="${RUN_NAME:-kimi-k2}"

if ! command -v dstack >/dev/null 2>&1; then
  echo "dstack CLI not found on PATH" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on PATH (install: brew install jq)" >&2
  exit 1
fi

JSON="$(dstack run get "$RUN_NAME" --json)"

STATUS="$(echo "$JSON" | jq -r '.status // empty')"
if [ "$STATUS" != "running" ]; then
  echo "Service $RUN_NAME is not running (status: ${STATUS:-unknown}). Try: dstack ps -v" >&2
  exit 1
fi

URL="$(echo "$JSON" | jq -r '.service.model.base_url // .service.url // empty')"
if [ -z "$URL" ]; then
  echo "Could not read service URL from dstack output" >&2
  exit 1
fi

# Strip a trailing /v1 if present — the AI SDK adds it back.
BASE_URL="${URL%/v1}"
BASE_URL="${BASE_URL%/}/v1"

TOKEN="$(dstack auth get-token 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  # Fallback: pull token from project config.
  TOKEN="$(jq -r '.projects[] | select(.default == true) | .token' "$HOME/.dstack/config.yml" 2>/dev/null || true)"
fi

if [ -z "$TOKEN" ]; then
  echo "Could not resolve dstack user token. Set KIMI_API_KEY manually." >&2
  exit 1
fi

echo "export KIMI_BASE_URL=\"$BASE_URL\""
echo "export KIMI_API_KEY=\"$TOKEN\""
