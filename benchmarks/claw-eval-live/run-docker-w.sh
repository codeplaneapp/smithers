#!/usr/bin/env bash
# Run the 5 terminal tasks (CTB_W01/03/04/05/06) in Docker mode, where the
# hidden verifiers' hardcoded /workspace paths resolve correctly. Same Smithers
# mixture brain drives them — only the sandbox execution mode differs.
# The filter "CTB_W0" matches exactly those 5 (NOT CTB_WORKFLOW_*).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor/Claw-Eval-Live"
cd "$VENDOR"
export CLAW_EVAL_MODEL_TIMEOUT_S="${CLAW_EVAL_MODEL_TIMEOUT_S:-300}"
exec ./.venv/bin/liveclaw-500 batch \
  --tasks-dir tasks --config config.smithers.yaml \
  --sandbox-mode docker --sandbox-image "${CLAW_SANDBOX_IMAGE:-liveclaw-500-agent:latest}" \
  --filter CTB_W0 --parallel "${1:-2}"
