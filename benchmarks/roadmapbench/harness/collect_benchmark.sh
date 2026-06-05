#!/usr/bin/env bash
# Collect results for runs launched by launch_benchmark.sh. For each finished
# run: read the recorded reward, run the post-hoc fairness audit (every command
# + the final diff), save the agent diff, then aggregate RR/CS and write a
# report. Safe to run repeatedly; it only finalizes runs that are done.
#
# Usage: collect_benchmark.sh            (collect all in runlist)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HARNESS="$ROOT/benchmarks/roadmapbench/harness"
DATA="$ROOT/.context/roadmapbench/data"
RUNS="$ROOT/.context/roadmapbench/runs"
CLI=(bun run "$ROOT/apps/cli/src/index.js")
RUNLIST="$RUNS/_runlist.tsv"
REPORT_DIR="$RUNS/_report"; mkdir -p "$REPORT_DIR"
RESULTS_JSONL="$REPORT_DIR/results.jsonl"; : > "$RESULTS_JSONL"
[[ -f "$RUNLIST" ]] || { echo "no runlist; launch first"; exit 2; }

while IFS=$'\t' read -r slug run_id manifest NOOP ORACLE; do
  [[ -z "$slug" ]] && continue
  work="$RUNS/$slug"; task_dir="$DATA/$slug"
  status="$("${CLI[@]}" inspect "$run_id" 2>/dev/null | grep -m1 'status:' | awk '{print $2}')"
  [[ -z "$status" ]] && status="unknown"
  echo "## $slug ($run_id) status=$status"
  repoDir="$(python3 -c "import json;print(json.load(open('$manifest'))['repoDir'])" 2>/dev/null)"
  image="$(python3 -c "import json;print(json.load(open('$manifest'))['image'])" 2>/dev/null)"

  # reward: prefer scorer output; fall back to a direct authoritative score
  reward="$(python3 -c "import json;print(json.load(open('$work/score.json'))['reward'])" 2>/dev/null || echo "")"
  if [[ -z "$reward" ]]; then
    echo "[collect] no scorer score.json; scoring directly ..."
    reward="$(bash "$HARNESS/score.sh" "$image" "$repoDir" "$task_dir/tests" "$work/score" | tail -1)"
  fi
  "${CLI[@]}" scores "$run_id" > "$work-scores.log" 2>&1 || true

  # save evidence + audit. Detached runs keep events in smithers' DB, so dump
  # the full command-level event history to a jsonl the auditor can scan.
  "${CLI[@]}" events "$run_id" --json --limit 100000 > "$work/events/events.jsonl" 2>/dev/null || true
  git -C "$repoDir" diff HEAD > "$work/agent.diff" 2>/dev/null || true
  python3 "$HARNESS/audit_run.py" "$work/events" "$repoDir" "$task_dir" "$work/audit.json" > "$work-audit.log" 2>&1 \
    && echo "[collect] audit: CLEAN" || echo "[collect] audit: TAINT (see $work/audit.json)"

  # meta (phases_passed/total_phases) comes from the grader's reward.json
  metafile="$work/score/reward.json"; [[ -f "$work/score.json" ]] && metafile="$work/score.json"
  python3 - "$slug" "$reward" "$NOOP" "$ORACLE" "$metafile" "$work/audit.json" "$status" >> "$RESULTS_JSONL" <<'PY'
import json,sys,os
slug,reward,noop,oracle,scorefile,auditfile,status=sys.argv[1:8]
def load(p):
    try: return json.load(open(p))
    except Exception: return {}
meta=load(scorefile); audit=load(auditfile)
try: r=float(reward)
except Exception: r=0.0
print(json.dumps({"task":slug,"status":status,"reward":r,"resolved":abs(r-1.0)<1e-9,
  "tainted":bool(audit.get("tainted",False)),"audit_signals":audit.get("signals",[]),
  "fairness":{"noop":float(noop),"oracle":float(oracle)},
  "phases_passed":meta.get("phases_passed"),"total_phases":meta.get("total_phases")}))
PY
done < "$RUNLIST"

python3 - "$RESULTS_JSONL" "$REPORT_DIR" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
# only count untainted runs toward the published numbers
valid=[r for r in rows if not r["tainted"]]
n=len(valid)
rr=sum(1 for r in valid if r["resolved"])/n if n else 0.0
cs=sum(r["reward"] for r in valid)/n if n else 0.0
report={"n_tasks_scored":n,"n_tainted":sum(1 for r in rows if r["tainted"]),
        "resolved_rate":rr,"completion_score":cs,"results":rows}
json.dump(report,open(sys.argv[2]+"/report.json","w"),indent=2)
print("\n================ RoadmapBench (smithers: opus 4.8 + codex 5.5) ================")
print(f"tasks scored (untainted): {n}")
print(f"Resolved Rate : {rr:.3f}")
print(f"Completion    : {cs:.3f}")
for r in rows:
    fp,tp=r.get("phases_passed"),r.get("total_phases")
    extra=f"  ({fp}/{tp} targets)" if fp is not None else ""
    t=" [TAINTED]" if r["tainted"] else ""
    print(f"  {r['task']:26s} reward={r['reward']:.3f}{extra}  status={r.get('status')}  [fair: noop={r['fairness']['noop']} oracle={r['fairness']['oracle']}]{t}")
PY
echo "[collect] report: $REPORT_DIR/report.json"
