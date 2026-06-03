#!/usr/bin/env bash
# Start the Smithers mixture-of-agents OpenAI-compatible gateway, with an
# auto-restart supervisor so a crash mid-batch self-heals (the benchmark retries
# connection errors per-task, so a quick restart is invisible to scores).
# Run this in one shell; run-one.sh / run-batch.sh in another.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
: "${OPENAI_API_KEY:?set OPENAI_API_KEY (used for gpt-5.5 gather + synthesis draft)}"
: "${GEMINI_API_KEY:?set GEMINI_API_KEY (used for the neutral arbiter + the benchmark judge)}"
cd "$REPO"
PORT="${CLAW_GATEWAY_PORT:-8788}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[start-gateway] a gateway is already listening on :$PORT — refusing to start a second supervisor." >&2
  exit 1
fi
while true; do
  # Opus 4.8 is reached via the `claude` CLI subscription; unset any API key so
  # ClaudeCodeAgent uses subscription auth (it does this itself, but be explicit).
  env -u ANTHROPIC_API_KEY bun "$HERE/gateway/src/server.ts"
  code=$?
  echo "[supervisor] gateway exited (code=$code); restarting in 2s..." >&2
  sleep 2
done
