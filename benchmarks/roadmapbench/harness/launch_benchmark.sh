#!/usr/bin/env bash
# Launch RoadmapBench-on-smithers runs DETACHED (so the smithers engine runs
# independently and survives beyond any single shell invocation). For each slug:
#   0. download from HuggingFace if missing
#   1. validate the scorer is fair (oracle=1.0, no-op<1.0) — cached
#   2. prepare the isolated agent workspace + offline container
#   3. `smithers up -d` (detached) through the gateway, recording the run id
# Poll/score/report with collect_benchmark.sh once the runs finish.
#
# Usage: launch_benchmark.sh <slug> [<slug> ...]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HARNESS="$ROOT/benchmarks/roadmapbench/harness"
DATA="$ROOT/.context/roadmapbench/data"
RUNS="$ROOT/.context/roadmapbench/runs"
WF="$ROOT/.smithers/workflows/roadmapbench.tsx"
CLI=(bun run "$ROOT/apps/cli/src/index.js")
mkdir -p "$RUNS"
RUNLIST="$RUNS/_runlist.tsv"; : > "$RUNLIST"

slugs=("$@")
[[ ${#slugs[@]} -eq 0 ]] && { echo "usage: launch_benchmark.sh <slug> [<slug>...]"; exit 2; }

download_task() {
  local slug="$1"; [[ -f "$DATA/$slug/task.toml" ]] && return 0
  echo "[launch] downloading $slug ..." >&2
  ( cd "$ROOT/.context/roadmapbench" && uv run --with huggingface_hub python3 - "$slug" <<'PY'
import sys; from huggingface_hub import snapshot_download
snapshot_download(repo_id='UnipatAI/RoadmapBench', repo_type='dataset', local_dir='./data',
                  allow_patterns=[f'{sys.argv[1]}/*']); print('ok')
PY
  )
}

for slug in "${slugs[@]}"; do
  echo "################ launch $slug ################"
  task_dir="$DATA/$slug"; work="$RUNS/$slug"
  download_task "$slug" || { echo "[launch] download FAILED $slug"; continue; }

  marker="$RUNS/$slug.validated"
  if [[ -f "$marker" ]]; then read -r NOOP ORACLE < "$marker"; echo "[launch] scorer pre-validated: noop=$NOOP oracle=$ORACLE"
  else
    echo "[launch] validating scorer fairness for $slug ..."
    if RMB_WORK="$RUNS/$slug-validate" bash "$HARNESS/validate_task.sh" "$task_dir" > "$work-validate.log" 2>&1; then
      NOOP="$(grep 'no-op reward'  "$work-validate.log" | tail -1 | grep -oE '[0-9.]+$')"
      ORACLE="$(grep 'oracle reward' "$work-validate.log" | tail -1 | grep -oE '[0-9.]+$')"
      echo "$NOOP $ORACLE" > "$marker"; rm -rf "$RUNS/$slug-validate"
      echo "[launch] fairness: noop=$NOOP oracle=$ORACLE"
    else echo "[launch] SCORER VALIDATION FAILED $slug — skipping"; tail -15 "$work-validate.log"; continue; fi
  fi

  bash "$HARNESS/prepare_task.sh" "$task_dir" "$work" > "$work-prepare.out" 2> "$work-prepare.log" || {
    echo "[launch] prepare FAILED $slug"; tail -15 "$work-prepare.log"; continue; }
  manifest="$work/manifest.json"; input="$(python3 -c "import json;print(json.dumps(json.load(open('$manifest'))))")"

  run_id="rmb-$slug"
  mkdir -p "$work/events"
  "${CLI[@]}" cancel "$run_id" >/dev/null 2>&1 || true
  echo "[launch] launching DETACHED run_id=$run_id ..."
  "${CLI[@]}" up "$WF" --input "$input" --run-id "$run_id" --detach \
      --max-concurrency 1 --allow-network --tool-timeout-ms 4500000 \
      --log --log-dir "$work/events" > "$work-launch.log" 2>&1
  echo "[launch] launch rc=$? (see $work-launch.log)"
  printf '%s\t%s\t%s\t%s\t%s\n' "$slug" "$run_id" "$manifest" "$NOOP" "$ORACLE" >> "$RUNLIST"
done
echo "[launch] runlist: $RUNLIST"; cat "$RUNLIST"
