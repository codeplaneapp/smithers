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
SELECTED="$ROOT/benchmarks/orchbench/persuasion-gap-selected.json"
CANONICAL_PATTERNS="solo-sol,sol-sol-sol,sol-terra-sol,plan-impl-review,plan-impl-review-blind,sol-work-sol-review,sol-work-fable-review,solo-fable,fable-fable-fable,fable-plan-impl-review"
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

if [[ "${ORCHBENCH_SKIP_GATES:-0}" == "1" && "$SMOKE" -ne 1 ]]; then
  echo "ORCHBENCH_SKIP_GATES is permitted only with --smoke" >&2
  exit 2
fi

if [[ "$ROUND" == "pg-confirm" && "$SMOKE" -eq 1 ]]; then
  echo "smoke runs may not use the confirmatory round name" >&2
  exit 2
fi

if [[ "$ROUND" == pg-confirm* && "$VALIDATE_ONLY" -eq 0 && "$SMOKE" -eq 0 ]]; then
  joined_patterns="$(IFS=,; echo "${PATTERNS[*]}")"
  if [[ "$ROUND" != "pg-confirm" || "$BALANCED_ORDER" -ne 1 || "$joined_patterns" != "$CANONICAL_PATTERNS" ]]; then
    echo "confirmation requires round pg-confirm, --balanced-order, and the canonical ten patterns" >&2
    exit 2
  fi
fi

WORKFLOW_HASH="$(shasum -a 256 "$WF" | awk '{print $1}')"
PROTOCOL_HASH="$({ shasum -a 256 "$ROOT/benchmarks/orchbench/driver.sh" "$WF" "$ROOT/.smithers/lib/roadmapScorer.ts" \
  "$ROOT/benchmarks/orchbench/collect_cell.ts" "$ROOT/benchmarks/orchbench/analyze_persuasion_gap.ts" \
  "$ROOT/benchmarks/orchbench/provider_processes.py" \
  "$ROOT/packages/scorers/src/estimateCostUsd.js" \
  "$ROOT/benchmarks/orchbench/persuasion-gap-sample.json" "$ROOT/benchmarks/orchbench/freeze_persuasion_gap_sample.ts" \
  "$ROOT/benchmarks/orchbench/verify_persuasion_gap_sample.ts" "$ROOT/benchmarks/orchbench/migrate_validation_receipts.py" \
  "$HARNESS/score.sh" "$HARNESS/audit_run.py" "$HARNESS/prepare_task.sh" "$HARNESS/validate_task.sh" \
  "$HARNESS/verify_validation_receipt.py";
  [[ -f "$SELECTED" ]] && shasum -a 256 "$SELECTED"; } | shasum -a 256 | awk '{print $1}')"

log() { printf '[driver %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
GATE_REFUSED=0

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
                  allow_patterns=[f'{sys.argv[1]}/*'], max_workers=1); print('ok')
PY
  )
}

validate_task() {
  local slug="$1"
  local marker="$OUT/validated/$slug" invalid="$INVALIDATED/$slug"
  if [[ -f "$marker" && -f "$invalid" ]]; then
    log "CONTRADICTORY validation decisions for $slug"
    return 1
  fi
  if [[ -f "$marker" ]]; then
    if RMB_SCORER_NETWORK="$RMB_SCORER_NETWORK" python3 "$HARNESS/verify_validation_receipt.py" "$DATA/$slug" "$marker" \
      > "$OUT/runs/$slug-receipt-image.txt" 2> "$OUT/runs/$slug-receipt-verify.log"; then
      return 0
    fi
    log "validation receipt is legacy/stale for $slug — revalidation required"
    mkdir -p "$OUT/legacy-validation"
    mv "$marker" "$OUT/legacy-validation/$slug-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  if [[ -f "$invalid" ]]; then
    if RMB_SCORER_NETWORK="$RMB_SCORER_NETWORK" python3 "$HARNESS/verify_validation_receipt.py" "$DATA/$slug" "$invalid" \
      > "$OUT/runs/$slug-invalid-receipt-image.txt" 2> "$OUT/runs/$slug-invalid-receipt-verify.log" && \
      python3 - "$invalid" <<'PY'
import json,sys
raise SystemExit(0 if json.load(open(sys.argv[1])).get("decision") == "invalid" else 1)
PY
    then
      log "skip invalid grader $slug (structured decision receipt)"
      return 1
    fi
    log "invalid decision receipt is legacy/stale for $slug — revalidation required"
    mkdir -p "$OUT/legacy-validation"
    mv "$invalid" "$OUT/legacy-validation/$slug-invalid-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  log "validating grader fairness for $slug (oracle=1.0, no-op<1.0) ..."
  local vlog="$OUT/runs/$slug-validate.log"
  if RMB_WORK="$OUT/runs/$slug-validate" bash "$HARNESS/validate_task.sh" "$DATA/$slug" > "$vlog" 2>&1; then
    local noop oracle
    noop="$(grep 'no-op reward' "$vlog" | tail -1 | grep -oE '[0-9.]+$')"
    oracle="$(grep 'oracle reward' "$vlog" | tail -1 | grep -oE '[0-9.]+$')"
    if [[ ! -f "$OUT/runs/$slug-validate/validation-receipt.json" ]]; then
      log "VALIDATION RECEIPT MISSING $slug — retry required"
      return 1
    fi
    cp "$OUT/runs/$slug-validate/validation-receipt.json" "$marker"
    rm -rf "$OUT/runs/$slug-validate"
    log "fairness OK $slug: noop=$noop oracle=$oracle"
  else
    local noop oracle
    noop="$(grep 'no-op reward' "$vlog" | tail -1 | grep -oE '[0-9.]+$')"
    oracle="$(grep 'oracle reward' "$vlog" | tail -1 | grep -oE '[0-9.]+$')"
    if [[ -n "$noop" && -n "$oracle" && -f "$OUT/runs/$slug-validate/out_noop/reward.json" && -f "$OUT/runs/$slug-validate/out_oracle/reward.json" ]]; then
      printf 'noop=%s oracle=%s\n' "$noop" "$oracle" > "$invalid"
      if ! python3 "$ROOT/benchmarks/orchbench/migrate_validation_receipts.py" \
        > "$OUT/runs/$slug-invalid-receipt-migrate.log" 2>&1; then
        log "INVALID DECISION RECEIPT FAILED $slug — not excluded; retry required"
        mkdir -p "$OUT/legacy-validation"
        mv "$invalid" "$OUT/legacy-validation/$slug-invalid-failed-$(date -u +%Y%m%dT%H%M%SZ)"
        return 1
      fi
      log "SCORER VALIDATION FAILED $slug — excluded (see $vlog)"
    else
      log "VALIDATION INFRASTRUCTURE FAILED $slug — not excluded; retry required (see $vlog)"
    fi
    return 1
  fi
}

prune_task_image() {
  local slug="$1" image pinned
  image="$(awk -F'"' '/docker_image/{print $2; exit}' "$DATA/$slug/task.toml")"
  pinned="$(python3 - "$OUT/validated/$slug" <<'PY' 2>/dev/null
import json,sys
try: print(json.load(open(sys.argv[1])).get("imagePinnedRef", ""))
except Exception: print("")
PY
)"
  [[ -n "${image:-}" ]] && docker rmi "$image" >/dev/null 2>&1 || true
  [[ -n "${pinned:-}" ]] && docker rmi "$pinned" >/dev/null 2>&1 || true
}

# Gate 1: never launch while ANY other run is actively RUNNING (foreign
# traffic poisons timing + rate limits). Parked waiting-quota runs are
# excluded deliberately: a superseded run can sit parked forever and would
# deadlock this gate; if one resumes mid-cell the cell's own quotaStall/
# timing flags catch the contamination.
# Overlap between OUR measured cells is never allowed (hard block). All other
# traffic and sustained host pressure are a bounded hard wait for measured
# cells. Bare detached engines are not evidence of traffic. Mid-cell provider
# or host pressure is recorded so timing summaries can exclude contaminated
# wall clocks.
running_workspace_runs() {
  "${CLI[@]}" ps 2>/dev/null | awk '/- id:/{id=$3} /^[[:space:]]*status: running$/{print id}'
}
wait_no_active_runs() {
  local deadline=$(( $(date +%s) + 30*60 )) clean_samples=0
  while [[ $(date +%s) -le $deadline ]]; do
    local runs ours others provider_count host_sample host_clean
    runs="$(running_workspace_runs)"
    ours="$(printf '%s\n' "$runs" | grep -c '^orchb-')" || ours=0
    others="$(printf '%s\n' "$runs" | grep -v '^orchb-' | grep -c .)" || others=0
    provider_count="$(python3 "$ROOT/benchmarks/orchbench/provider_processes.py" | wc -l | tr -d ' ')" || provider_count=0
    host_sample="$(iostat -w 10 -c 2 2>/dev/null | awk 'END {print $3, $6}')"
    host_clean="$(awk -v sample="$host_sample" 'BEGIN {split(sample,a," "); print (a[1] <= 5 && a[2] >= 75) ? 1 : 0}')"
    if [[ "${ours:-0}" -eq 0 && "${others:-0}" -eq 0 && "${provider_count:-0}" -eq 0 && "$host_clean" -eq 1 ]]; then
      clean_samples=$((clean_samples + 1))
      log "gate: clean sample $clean_samples/3 (diskMBps/cpuIdle=$host_sample)"
      [[ $clean_samples -ge 3 ]] && return 0
    else
      clean_samples=0
      log "gate: orchbench=$ours other-runs=$others provider-sessions=$provider_count diskMBps/cpuIdle=$host_sample — waiting"
    fi
  done
  log "gate: no 30-second clean window within 30 minutes — refusing measured launch"
  return 1
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
base = (r.get("status") == "RunFinished"
        and r.get("quotaPoisoned") is False
        and r.get("tainted") is False)
confirm = (r.get("auditError") is None
           and r.get("resultSchemaVersion") == 2
           and isinstance(r.get("reward"), (int, float))
           and 0 <= r["reward"] <= 1
           and bool(r.get("workflowHash"))
           and bool(r.get("protocolHash")))
sys.exit(0 if base and (r.get("smoke") is True or confirm) else 1)
PY
}

wait_anthropic_retry_window() {
  local result="$1" remaining
  while :; do
    remaining="$(python3 - "$result" <<'PY' 2>/dev/null
import datetime, json, sys
r=json.load(open(sys.argv[1]))
models=r.get("usageByModel") or {}
if not r.get("quotaPoisoned") or not any("claude" in model.lower() for model in models):
    print(0); raise SystemExit
collected=datetime.datetime.fromisoformat(r["collectedAt"].replace("Z", "+00:00"))
ready=collected + datetime.timedelta(hours=5, minutes=5)
print(max(0, int((ready-datetime.datetime.now(datetime.timezone.utc)).total_seconds())))
PY
)"
    [[ -z "$remaining" || "$remaining" -le 0 ]] && return 0
    log "Anthropic-poisoned attempt: retry cooldown has ${remaining}s remaining"
    sleep $((remaining < 60 ? remaining : 60))
  done
}

run_cell() {
  local slug="$1" pattern="$2"
  GATE_REFUSED=0
  local base_cell="$ROUND-$pattern-$slug" cell="$ROUND-$pattern-$slug" attempt=0
  local resfile="$OUT/results/$cell.json"
  while [[ -f "$resfile" ]]; do
    if result_is_clean "$resfile"; then
      log "skip $cell (clean result exists)"
      return 0
    fi
    if [[ $attempt -ge 1 ]]; then
      log "invalid $base_cell already used its single preregistered retry — stopping"
      return 1
    fi
    wait_anthropic_retry_window "$resfile"
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
      wait_no_active_runs || { GATE_REFUSED=1; return 1; }
      wait_codex_quota
    fi
    log "prepare $cell"
    local receipt="$OUT/validated/$slug" image_override receipt_hash selected_hash launch_started_at
    image_override="$(python3 - "$receipt" <<'PY' 2>/dev/null
import json,sys
try: print(json.load(open(sys.argv[1])).get("imagePinnedRef", ""))
except Exception: print("")
PY
)"
    receipt_hash="$(shasum -a 256 "$receipt" 2>/dev/null | awk '{print $1}')"
    selected_hash=""
    [[ -f "$SELECTED" ]] && selected_hash="$(shasum -a 256 "$SELECTED" | awk '{print $1}')"
    RMB_IMAGE_OVERRIDE="$image_override" bash "$HARNESS/prepare_task.sh" "$DATA/$slug" "$work" > "$work-prepare.out" 2> "$work-prepare.log" || {
      log "prepare FAILED $cell (see $work-prepare.log)"; return 1; }
    local input mc
    launch_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    input="$(python3 - "$work/manifest.json" "$pattern" "$PANEL_THIRD" "$SMOKE" "$BALANCED_ORDER" \
      "$WORKFLOW_HASH" "$PROTOCOL_HASH" "${CURRENT_TASK_ORDINAL:-0}" "${CURRENT_PATTERN_ORDER_CSV:-$pattern}" \
      "${CURRENT_PATTERN_POSITION:-0}" "$launch_started_at" "$receipt_hash" "$selected_hash" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
m["pattern"]=sys.argv[2]; m["panelThird"]=sys.argv[3]; m["smoke"]=sys.argv[4]=="1"
m["balancedOrder"]=sys.argv[5]=="1"
m["workflowHash"]=sys.argv[6]; m["protocolHash"]=sys.argv[7]
m["taskOrdinal"]=int(sys.argv[8]); m["plannedPatternOrder"]=sys.argv[9].split(",")
m["patternPosition"]=int(sys.argv[10]); m["launchStartedAt"]=sys.argv[11]
m["validationReceiptSha256"]=sys.argv[12]
m["selectedSampleSha256"]=sys.argv[13] or None
json.dump(m, open(sys.argv[1], "w"), indent=2)
print(json.dumps(m))
PY
)"
    mc=1; [[ "$pattern" == "panel-review" ]] && mc=3
    mkdir -p "$work/events"
    # Record concurrent traffic at launch so collect can flag contended wall clocks.
    { running_workspace_runs | grep -v '^orchb-' | sed 's/^/workspace-run: /';
      python3 "$ROOT/benchmarks/orchbench/provider_processes.py" | sed 's/^/provider: /'; } > "$work/foreign-at-launch.txt" || true
    log "launch $cell run_id=$run_id (max-concurrency $mc)"
    if ! "${CLI[@]}" up "$WF" --input "$input" --run-id "$run_id" --detach \
      --max-concurrency "$mc" --allow-network --tool-timeout-ms 4500000 \
      --log --log-dir "$work/events" > "$work-launch.log" 2>&1; then
      log "launch FAILED $cell (see $work-launch.log)"
      return 1
    fi
    log "launch rc=0 (see $work-launch.log)"
  else
    log "$cell run exists (status=$known_status) — resuming poll"
  fi

  # Poll to terminal. Cap: 8h per cell, then cancel + collect as timeout.
  local deadline=$(( $(date +%s) + 8*3600 ))
  while :; do
    local st engine_pid host_sample
    st="$("${CLI[@]}" inspect "$run_id" 2>/dev/null | grep -m1 'status:' | awk '{print $2}')"
    engine_pid="$(ps -axo pid=,command= | awk -v id="$run_id" 'index($0,id)>0 {print $1; exit}')"
    { running_workspace_runs | grep -v "^$run_id$" | sed 's/^/workspace-run: /';
      if [[ -n "$engine_pid" ]]; then
        python3 "$ROOT/benchmarks/orchbench/provider_processes.py" --exclude-root "$engine_pid"
      else
        python3 "$ROOT/benchmarks/orchbench/provider_processes.py"
      fi | sed 's/^/provider: /';
    } >> "$work/foreign-during-run.txt" 2>/dev/null || true
    host_sample="$(iostat -w 1 -c 2 2>/dev/null | awk 'END {print $3, $6}')"
    awk -v sample="$host_sample" 'BEGIN {split(sample,a," "); if (a[1] > 5 || a[2] < 75) print "host: diskMBps="a[1]" cpuIdle="a[2]}' \
      >> "$work/foreign-during-run.txt"
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
  local collect_attempt collected=0
  for collect_attempt in 1 2 3; do
    if bun "$ROOT/benchmarks/orchbench/collect_cell.ts" "$run_id" "$slug" "$pattern" "$work/manifest.json" "$resfile" \
      > "$work-collect.log" 2>&1; then
      collected=1
      break
    fi
    log "collect attempt $collect_attempt FAILED $cell (see $work-collect.log)"
    sleep 10
  done
  [[ "$collected" -eq 1 && -f "$resfile" ]] || return 1
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
  result_is_clean "$resfile"
}

if [[ "$ROUND" == "pg-confirm" && "$VALIDATE_ONLY" -eq 0 && "$SMOKE" -eq 0 ]]; then
  [[ -f "$SELECTED" ]] || { log "confirm preflight FAILED: frozen selected-sample artifact is missing"; exit 2; }
  bun "$ROOT/benchmarks/orchbench/verify_persuasion_gap_sample.ts" >/dev/null || {
    log "confirm preflight FAILED: candidate-frame verification failed"; exit 2; }
  bun "$ROOT/benchmarks/orchbench/freeze_persuasion_gap_sample.ts" >/dev/null || {
    log "confirm preflight FAILED: current decisions do not reproduce the frozen sample"; exit 2; }
  expected_tasks="$(python3 - "$SELECTED" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); print(",".join(task["slug"] for task in s["tasks"]))
PY
)"
  actual_tasks="$(IFS=,; echo "${TASKS[*]}")"
  [[ "$actual_tasks" == "$expected_tasks" ]] || { log "confirm preflight FAILED: task list/order differs from frozen sample"; exit 2; }
  log "confirm preflight: verifying all 30 frozen graders before any model cell"
  for slug in "${TASKS[@]}"; do
    download_task "$slug" || { log "confirm preflight download FAILED $slug"; exit 1; }
    validate_task "$slug" || { log "confirm preflight validation FAILED $slug"; exit 1; }
  done
  python3 - "$SELECTED" "$OUT/validated" "$INVALIDATED" "$CANONICAL_PATTERNS" \
    "$ROOT/benchmarks/orchbench/persuasion-gap-sample.json" <<'PY' || exit 1
import hashlib,json,pathlib,sys
selected=json.load(open(sys.argv[1])); valid=pathlib.Path(sys.argv[2]); invalid=pathlib.Path(sys.argv[3])
canonical=sys.argv[4]; frame=json.load(open(sys.argv[5]))
if selected.get("schemaVersion") != 1 or len(selected.get("tasks", [])) != 30:
    raise SystemExit("invalid frozen selected-sample artifact")
for key in ("targetTasks","targetPerLanguage","minimumPerLanguage","overflowLanguageOrder","datasetRevision"):
    if selected.get(key) != frame.get(key): raise SystemExit(f"frozen sampling metadata mismatch: {key}")
if ",".join(selected.get("conditionOrder", [])) != canonical:
    raise SystemExit("frozen condition order mismatch")
tasks=selected["tasks"]; slugs=[task["slug"] for task in tasks]
if len(set(slugs)) != 30 or any(slug in frame["pilotExcluded"] for slug in slugs):
    raise SystemExit("duplicate or pilot task in frozen sample")
counts={language:0 for language in frame["candidates"]}
for ordinal,task in enumerate(selected["tasks"]):
    if task.get("ordinal") != ordinal: raise SystemExit("noncanonical task ordinal")
    language=task.get("language"); slug=task.get("slug"); rank=task.get("candidateRank")
    if language not in counts or not isinstance(rank,int) or rank < 1 or frame["candidates"][language][rank-1] != slug:
        raise SystemExit(f"candidate membership/rank mismatch: {slug}")
    counts[language]+=1
    receipt=valid/task["slug"]
    digest=hashlib.sha256(receipt.read_bytes()).hexdigest()
    if digest != task["validationReceiptSha256"]: raise SystemExit(f"receipt changed: {task['slug']}")
    parsed=json.loads(receipt.read_text())
    if parsed.get("imagePinnedRef") != task["imagePinnedRef"]: raise SystemExit(f"image changed: {task['slug']}")
if set(counts) != set(frame["candidates"]) or min(counts.values()) < frame["minimumPerLanguage"]:
    raise SystemExit(f"language floor/count mismatch: {counts}")
decisions=selected.get("decisions",[])
if len({(d.get("language"),d.get("candidateRank")) for d in decisions}) != len(decisions):
    raise SystemExit("duplicate frozen decision")
for decision in decisions:
    language=decision.get("language"); rank=decision.get("candidateRank"); slug=decision.get("slug")
    if language not in frame["candidates"] or not isinstance(rank,int) or frame["candidates"][language][rank-1] != slug:
        raise SystemExit(f"decision membership/rank mismatch: {slug}")
    status=decision.get("status")
    if status not in ("pass","invalid"): raise SystemExit(f"invalid decision status: {slug}")
    path=(valid if status=="pass" else invalid)/slug
    if hashlib.sha256(path.read_bytes()).hexdigest() != decision.get("decisionReceiptSha256"):
        raise SystemExit(f"decision receipt changed: {slug}")
pass_decisions={d["slug"] for d in decisions if d.get("status")=="pass"}
if not set(slugs).issubset(pass_decisions): raise SystemExit("selected task missing from decision ledger")
summary=selected.get("languageSelection",{})
if set(summary) != set(counts) or any(summary[language].get("finalCount") != count for language,count in counts.items()):
    raise SystemExit("language-selection summary mismatch")
PY
  log "confirm preflight PASSED: sample, graders, images, and receipts are frozen"
fi

log "OrchBench $ROUND: ${#TASKS[@]} task(s) x ${#PATTERNS[@]} pattern(s), smoke=$SMOKE, panelThird=$PANEL_THIRD, balancedOrder=$BALANCED_ORDER"
FAILURES=0
task_index=0
for slug in "${TASKS[@]}"; do
  download_task "$slug" || { log "download FAILED $slug — skipping task"; FAILURES=$((FAILURES + 1)); continue; }
  if ! validate_task "$slug"; then
    [[ "$VALIDATE_ONLY" -eq 1 ]] && prune_task_image "$slug"
    FAILURES=$((FAILURES + 1))
    continue
  fi
  if [[ "$VALIDATE_ONLY" -eq 1 ]]; then
    prune_task_image "$slug"
    log "validate-only: $slug done; image pruned"
    continue
  fi
  ORDERED_PATTERNS=("${PATTERNS[@]}")
  CURRENT_TASK_ORDINAL="$task_index"
  if [[ "$ROUND" == "pg-confirm" ]]; then
    CURRENT_TASK_ORDINAL="$(python3 - "$SELECTED" "$slug" <<'PY'
import json,sys
s=json.load(open(sys.argv[1])); print(next(t["ordinal"] for t in s["tasks"] if t["slug"]==sys.argv[2]))
PY
)"
  fi
  if [[ "$BALANCED_ORDER" -eq 1 && "${#PATTERNS[@]}" -gt 1 ]]; then
    ORDERED_PATTERNS=()
    offset=$((CURRENT_TASK_ORDINAL % ${#PATTERNS[@]}))
    for ((pattern_index=0; pattern_index<${#PATTERNS[@]}; pattern_index++)); do
      ORDERED_PATTERNS+=("${PATTERNS[$(((pattern_index + offset) % ${#PATTERNS[@]}))]}")
    done
  fi
  CURRENT_PATTERN_ORDER_CSV="$(IFS=,; echo "${ORDERED_PATTERNS[*]}")"
  pattern_position=0
  for pattern in "${ORDERED_PATTERNS[@]}"; do
    CURRENT_PATTERN_POSITION="$pattern_position"
    if ! run_cell "$slug" "$pattern"; then
      if [[ "$ROUND" == "pg-confirm" && "$GATE_REFUSED" -eq 1 ]]; then
        log "confirm launch aborted cleanly after isolation-gate timeout; no condition consumed"
        exit 75
      fi
      FAILURES=$((FAILURES + 1))
    fi
    pattern_position=$((pattern_position + 1))
  done
  task_index=$((task_index + 1))
  # task finished all its cells: reclaim the (qemu, multi-GB) image
  prune_task_image "$slug"
  log "task $slug complete; image pruned"
done
if [[ "$VALIDATE_ONLY" -eq 1 ]]; then
  if [[ "$FAILURES" -eq 0 ]]; then
    log "VALIDATION SWEEP DONE"
    touch "$OUT/.validate-complete"
  else
    log "VALIDATION SWEEP INCOMPLETE: $FAILURES failure(s)"
    exit 1
  fi
else
  if [[ "$FAILURES" -eq 0 ]]; then
    log "ALL CELLS DONE"
    touch "$OUT/results/.$ROUND-complete"
  else
    log "CELL SWEEP INCOMPLETE: $FAILURES failure(s); no completion sentinel written"
    exit 1
  fi
fi
