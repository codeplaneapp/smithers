#!/usr/bin/env bash
# Fetch the upstream Claw-Eval-Live benchmark and install it into a local venv.
# The benchmark itself is NOT vendored into git (CC-BY upstream); this script
# reproduces the exact environment used for the Smithers run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor/Claw-Eval-Live"
REPO_URL="${CLAW_REPO_URL:-https://github.com/Claw-Eval-Live/Claw-Eval-Live.git}"

if [ ! -d "$VENDOR/.git" ]; then
  mkdir -p "$HERE/vendor"
  git clone --depth 1 "$REPO_URL" "$VENDOR"
fi

cd "$VENDOR"
uv venv --python 3.12 .venv
VIRTUAL_ENV="$VENDOR/.venv" uv pip install -e ".[mock,dev]"
cp -f "$HERE/config.smithers.yaml" "$VENDOR/config.smithers.yaml"

echo
echo "Setup complete."
echo "  benchmark: $VENDOR  ($(.venv/bin/liveclaw-500 list --tasks-dir tasks | grep -c CTB) tasks)"
echo "  next: ./start-gateway.sh   (in one shell)   then   ./run-batch.sh   (in another)"
