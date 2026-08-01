#!/usr/bin/env bash
# OrchBench fleet driver: runs pattern x task cells STRICTLY ONE AT A TIME
# (rate-limit hygiene, see DESIGN.md). Idempotent: cells with an existing
# result file are skipped; an existing non-terminal run is re-polled, a
# terminal one is collected. Safe to re-run after any crash/reboot.
#
# Usage:
#   driver.sh                        # full round 1 (4 tasks x 5 patterns)
#   driver.sh --tasks vbt-1.2.0-roadmap --patterns panel-review --smoke
#   driver.sh --round r2 --tasks ... --patterns ...
set -uo pipefail
# RoadmapBench target releases can introduce dependencies absent from their
# official images. Agent execution remains offline; only the uncredentialed,
# post-run grader receives dependency access for this experiment.
export RMB_SCORER_NETWORK="${RMB_SCORER_NETWORK:-bridge}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HARNESS="$ROOT/benchmarks/roadmapbench/harness"
DATA="$ROOT/.context/roadmapbench/data"
OUT="$ROOT/.context/orchbench"
INVALIDATED="$OUT/invalidated"
CLI=(bun run "$ROOT/apps/cli/src/index.js")
WF="$ROOT/.smithers/workflows/orchbench.tsx"
mkdir -p "$OUT/results" "$OUT/runs" "$OUT/validated" "$INVALIDATED"

ROUND="r1"
TASKS=(vbt-1.2.0-roadmap opt-4.4.0-roadmap fbr-2.42.0-roadmap rat-0.21.0-roadmap)
PATTERNS=(solo-sol solo-luna plan-impl-review research-first panel-review)
SMOKE=0
VALIDATE_ONLY=0
BALANCED_ORDER=0
PANEL_THIRD="${ORCHBENCH_PANEL_THIRD:-opus}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --round) ROUND="$2"; shift 2 ;;
    --tasks) IFS=',' read -r -a TASKS <<< "$2"; shift 2 ;;
    --patterns) IFS=',' read -r -a PATTERNS <<< "$2"; shift 2 ;;
    --smoke) SMOKE=1; shift ;;
    --validate-only) VALIDATE_ONLY=1; shift ;;
    --balanced-order) BALANCED_ORDER=1; shift ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done

log() { printf '[driver %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

download_task() {
  local slug="$1"
  # A task.toml can arrive before an interrupted snapshot is complete. Only
  # trust local data once its grader has reached a terminal fairness decision;
  # otherwise snapshot_download resumes and verifies the partial download.
  if [[ -f "$DATA/$slug/task.toml" && ( -f "$OUT/validated/$slug" || -f "$INVALIDATED/$slug" ) ]]; then
    return 0
  fi
  log "downloading $slug ..."
  # Resolve the downloader from uv's local cache. Network here is for the
  # pinned dataset only; a transient package-index outage must not prevent a
  # resumable snapshot download.
  ( cd "$ROOT/.context/roadmapbench" && uv run --offline --with huggingface_hub python3 - "$slug" <<'PY'
import sys; from huggingface_hub import snapshot_download
snapshot_download(repo_id='UnipatAI/RoadmapBench', repo_type='dataset', local_dir='./data',
                  revision='59184e779909300a5a0150b06b945d39da81a099',
                  allow_patterns=[f'{sys.argv[1]}/*'], max_workers=4); print('ok')
PY
  )
}

validate_task() {
  local slug="$1" marker="$OUT/validated/$slug" invalid="$INVALIDATED/$slug"
  [[ -f "$marker" ]] && return 0
  [[ -f "$invalid" ]] && { log "skip invalid grader $slug ($(cat "$invalid"))"; return 1; }
  log "validating grader fairness for $slug (oracle=1.0, no-op<1.0) ..."
  local vlog="$OUT/runs/$slug-validate.log"
  if RMB_WORK="$OUT/runs/$slug-validate" bash "$HARNESS/validate_task.sh" "$DATA/$slug" > "$vlog" 2>&1; then
    local noop oracle
    noop="$(grep 'no-op reward' "$vlog" | tail -1 | grep -oE '[0-9.]+$')"
    oracle="$(grep 'oracle reward' "$vlog" | tail -1 | grep -oE '[0-9.]+$')"
    echo "$noop $oracle" > "$marker"; rm -rf "$OUT/runs/$slug-validate"
    log "fairness OK $slug: noop=$noop oracle=$oracle"
  else
    local noop oracle
    noop="$(grep 'no-op reward' "$vlog" | tail -1 | grep -oE '[0-9.]+$')"
    oracle="$(grep 'oracle reward' "$vlog" | tail -1 | grep -oE '[0-9.]+$')"
    if [[ -n "$noop" && -n "$oracle" ]]; then
      printf 'noop=%s oracle=%s\n' "$noop" "$oracle" > "$invalid"
      log "SCORER VALIDATION FAILED $slug — excluded (see $vlog)"
    else
      log "VALIDATION INFRASTRUCTURE FAILED $slug — not excluded; retry required (see $vlog)"
    fi
    return 1
  fi
}

prune_task_image() {
  local slug="$1" image
  image="$(awk -F'"' '/docker_image/{print $2; exit}' "$DATA/$slug/task.toml")"
  [[ -n "${image:-}" ]] && docker rmi "$image" >/dev/null 2>&1 || true
}

# Gate 1: never launch while ANY other run is actively RUNNING (foreign
# traffic poisons timing + rate limits). Parked waiting-quota runs are
# excluded deliberately: a superseded run can sit parked forever and would
# deadlock this gate; if one resumes mid-cell the cell's own quotaStall/
# timing flags catch the contamination.
# Overlap between OUR measured cells is never allowed (hard block). All other
# traffic — other runs in this workspace and other workspaces' engines — gets
# a bounded 10m wait, then we proceed and the cell is flagged contended (cost
# and reward are contention-immune; wall-clock carries the flag).
running_workspace_runs() {
  "${CLI[@]}" ps 2>/dev/null | awk '/- id:/{id=$3} /^\s*status: running$/{print id}'
}
wait_no_active_runs() {
  local waited=0
  while :; do
    local runs ours others foreign
    runs="$(running_workspace_runs)"
    ours="$(printf '%s\n' "$runs" | grep -c '^orchb-')" || ours=0
    others="$(printf '%s\n' "$runs" | grep -v '^orchb-' | grep -c .)" || others=0
    foreign="$(pgrep -f 'src/index.js up |smithers.js up ' 2>/dev/null | wc -l | tr -d ' ')" || foreign=0
    if [[ "${ours:-0}" -gt 0 ]]; then
      log "gate: $ours orchbench cell(s) still running — hard wait"
    elif [[ "${others:-0}" -eq 0 && "${foreign:-0}" -eq 0 ]]; then
      return 0
    elif [[ $waited -ge 600 ]]; then
      log "gate: WARNING others=$others foreign=$foreign still active after 10m — proceeding (cell flagged contended)"
      return 0
    else
      log "gate: others=$others workspace run(s), foreign=$foreign engine proc(s) — waiting 120s"
    fi
    sleep 120; waited=$((waited + 120))
  done
}

# Gate 2: codex weekly quota headroom.
wait_codex_quota() {
  while :; do
    local pct
    pct="$("${CLI[@]}" usage 2>/dev/null | awk '/codex/{for(i=1;i<=NF;i++) if ($i ~ /^[0-9]+%$/){gsub("%","",$i);print $i; exit}}')"
    if [[ -z "$pct" ]]; then log "gate: cannot read codex usage — proceeding cautiously"; return 0; fi
    [[ "$pct" -lt 85 ]] && { log "gate: codex weekly at ${pct}% — OK"; return 0; }
    log "gate: codex weekly at ${pct}% >= 85% — parking 1800s"
    sleep 1800
  done
}

result_is_clean() {
  python3 - "$1" <<'PY' 2>/dev/null
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if r.get("status") == "RunFinished"
         and r.get("quotaPoisoned") is False
         and r.get("tainted") is False else 1)
PY
}

run_cell() {
  local slug="$1" pattern="$2"
  local base_cell="$ROUND-$pattern-$slug" cell="$ROUND-$pattern-$slug" attempt=0
  local resfile="$OUT/results/$cell.json"
  while [[ -f "$resfile" ]]; do
    if result_is_clean "$resfile"; then
      log "skip $cell (clean result exists)"
      return 0
    fi
    attempt=$((attempt + 1))
    cell="$base_cell-retry$attempt"
    resfile="$OUT/results/$cell.json"
  done
  [[ $attempt -gt 0 ]] && log "retrying invalid $base_cell as $cell (raw attempts retained)"
  local run_id="orchb-$cell"
  local work="$OUT/runs/$cell"

  # If the run already exists, do not re-prepare (that would wipe the
  # workspace of an in-flight/finished run) — just poll + collect.
  local known_status
  known_status="$("${CLI[@]}" inspect "$run_id" 2>/dev/null | grep -m1 'status:' | awk '{print $2}')"
  if [[ -z "$known_status" ]]; then
    # ORCHBENCH_SKIP_GATES=1 is for unmeasured smoke cells only.
    if [[ "${ORCHBENCH_SKIP_GATES:-0}" != "1" ]]; then
      wait_no_active_runs
      wait_codex_quota
    fi
    log "prepare $cell"
    bash "$HARNESS/prepare_task.sh" "$DATA/$slug" "$work" > "$work-prepare.out" 2> "$work-prepare.log" || {
      log "prepare FAILED $cell (see $work-prepare.log)"; return 1; }
    local input mc
    input="$(python3 - "$work/manifest.json" "$pattern" "$PANEL_THIRD" "$SMOKE" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
m["pattern"]=sys.argv[2]; m["panelThird"]=sys.argv[3]; m["smoke"]=sys.argv[4]=="1"
print(json.dumps(m))
PY
)"
    mc=1; [[ "$pattern" == "panel-review" ]] && mc=3
    mkdir -p "$work/events"
    # record concurrent traffic at launch so collect can flag contended wall-clocks
    { running_workspace_runs | grep -v '^orchb-' | sed 's/^/workspace-run: /';
      pgrep -f 'src/index.js up |smithers.js up ' 2>/dev/null | sed 's/^/engine-pid: /'; } > "$work/foreign-at-launch.txt" || true
    log "launch $cell run_id=$run_id (max-concurrency $mc)"
    "${CLI[@]}" up "$WF" --input "$input" --run-id "$run_id" --detach \
      --max-concurrency "$mc" --allow-network --tool-timeout-ms 4500000 \
      --log --log-dir "$work/events" > "$work-launch.log" 2>&1
    log "launch rc=$? (see $work-launch.log)"
  else
    log "$cell run exists (status=$known_status) — resuming poll"
  fi

  # Poll to terminal. Cap: 8h per cell, then cancel + collect as timeout.
  local deadline=$(( $(date +%s) + 8*3600 ))
  while :; do
    local st
    st="$("${CLI[@]}" inspect "$run_id" 2>/dev/null | grep -m1 'status:' | awk '{print $2}')"
    case "$st" in
      finished|failed|cancelled) log "$cell terminal: $st"; break ;;
      waiting-quota) log "$cell WAITING-QUOTA (sample will be flagged poisoned)" ;;
      *) : ;;
    esac
    if [[ $(date +%s) -gt $deadline ]]; then
      log "$cell exceeded 8h — cancelling"
      "${CLI[@]}" cancel "$run_id" >/dev/null 2>&1 || true
      break
    fi
    sleep 60
  done

  log "collect $cell"
  bun "$ROOT/benchmarks/orchbench/collect_cell.ts" "$run_id" "$slug" "$pattern" "$work/manifest.json" "$resfile" \
    > "$work-collect.log" 2>&1 || log "collect FAILED $cell (see $work-collect.log)"
  # container down (image kept until the task's last cell)
  local container agent_home
  container="$(python3 -c "import json;print(json.load(open('$work/manifest.json'))['container'])" 2>/dev/null)"
  [[ -n "${container:-}" ]] && docker rm -f "$container" >/dev/null 2>&1 || true
  # agent home is disposable once the diff + score are captured by collect
  agent_home="$(python3 -c "import json;print(json.load(open('$work/manifest.json'))['agentHome'])" 2>/dev/null)"
  [[ -n "${agent_home:-}" && "$agent_home" == "$HOME/.cache/roadmapbench/homes/"* ]] && rm -rf "$agent_home"
  # one-line summary for the monitor
  python3 - "$resfile" <<'PY' 2>/dev/null || true
import json,sys
try: r=json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
print(f"RESULT {r['pattern']} {r['slug']} reward={r['reward']:.3f} wall={r['wallS']}s cost=${r['costUsd']:.2f} status={r['status']} tainted={r['tainted']} quotaStall={r['quotaStallS']}s")
PY
}

log "OrchBench $ROUND: ${#TASKS[@]} task(s) x ${#PATTERNS[@]} pattern(s), smoke=$SMOKE, panelThird=$PANEL_THIRD, balancedOrder=$BALANCED_ORDER"
task_index=0
for slug in "${TASKS[@]}"; do
  download_task "$slug" || { log "download FAILED $slug — skipping task"; continue; }
  if ! validate_task "$slug"; then
    [[ "$VALIDATE_ONLY" -eq 1 ]] && prune_task_image "$slug"
    continue
  fi
  if [[ "$VALIDATE_ONLY" -eq 1 ]]; then
    prune_task_image "$slug"
    log "validate-only: $slug done; image pruned"
    continue
  fi
  ORDERED_PATTERNS=("${PATTERNS[@]}")
  if [[ "$BALANCED_ORDER" -eq 1 && "${#PATTERNS[@]}" -gt 1 ]]; then
    ORDERED_PATTERNS=()
    offset=$((task_index % ${#PATTERNS[@]}))
    for ((pattern_index=0; pattern_index<${#PATTERNS[@]}; pattern_index++)); do
      ORDERED_PATTERNS+=("${PATTERNS[$(((pattern_index + offset) % ${#PATTERNS[@]}))]}")
    done
  fi
  for pattern in "${ORDERED_PATTERNS[@]}"; do
    run_cell "$slug" "$pattern"
  done
  task_index=$((task_index + 1))
  # task finished all its cells: reclaim the (qemu, multi-GB) image
  image="$(awk -F'"' '/docker_image/{print $2; exit}' "$DATA/$slug/task.toml")"
  [[ -n "${image:-}" ]] && docker rmi "$image" >/dev/null 2>&1 || true
  log "task $slug complete; image pruned"
done
if [[ "$VALIDATE_ONLY" -eq 1 ]]; then
  log "VALIDATION SWEEP DONE"
  touch "$OUT/.validate-complete"
else
  log "ALL CELLS DONE"
  touch "$OUT/results/.$ROUND-complete"
fi
