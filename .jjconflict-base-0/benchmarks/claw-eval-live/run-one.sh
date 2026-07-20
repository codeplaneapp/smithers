#!/usr/bin/env bash
# Run a single task through the Smithers gateway and grade it with the
# benchmark's real grader + neutral Gemini judge.
#   ./run-one.sh CTB_HR_01_onboarding_checklist [extra liveclaw-500 args...]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor/Claw-Eval-Live"
TASK="${1:?usage: run-one.sh <task-dir-name> [extra args...]}"; shift || true
cd "$VENDOR"
export CLAW_EVAL_MODEL_TIMEOUT_S="${CLAW_EVAL_MODEL_TIMEOUT_S:-300}"
exec ./.venv/bin/liveclaw-500 run \
  --task "tasks/$TASK" \
  --config config.smithers.yaml \
  --sandbox-mode local \
  "$@"
