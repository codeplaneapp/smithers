#!/usr/bin/env bash
# Run the benchmark (all tasks, or a filtered subset) through the Smithers
# gateway, grading each with the benchmark's real grader + neutral Gemini judge.
#   ./run-batch.sh                 # all 105 tasks, 3 parallel workers
#   ./run-batch.sh CTB_HR 2        # only tasks matching CTB_HR, 2 workers
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor/Claw-Eval-Live"
FILTER="${1:-}"
PAR="${2:-3}"
cd "$VENDOR"
export CLAW_EVAL_MODEL_TIMEOUT_S="${CLAW_EVAL_MODEL_TIMEOUT_S:-300}"
ARGS=(batch --tasks-dir tasks --config config.smithers.yaml --sandbox-mode local --parallel "$PAR" --port-base-offset "${CLAW_PORT_BASE:-0}")
[ -n "$FILTER" ] && ARGS+=(--filter "$FILTER")
exec ./.venv/bin/liveclaw-500 "${ARGS[@]}"
