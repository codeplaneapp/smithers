#!/usr/bin/env bash
# Exact, resumable entrypoint for the frozen 30-task x 10-condition study.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SELECTED="$ROOT/benchmarks/orchbench/persuasion-gap-selected.json"
PATTERNS="solo-sol,sol-sol-sol,sol-terra-sol,plan-impl-review,plan-impl-review-blind,sol-work-sol-review,sol-work-fable-review,solo-fable,fable-fable-fable,fable-plan-impl-review"

[[ -f "$SELECTED" ]] || { echo "freeze persuasion-gap-selected.json first" >&2; exit 2; }
TASKS="$(python3 - "$SELECTED" <<'PY'
import json,sys
selected=json.load(open(sys.argv[1]))
print(",".join(task["slug"] for task in selected["tasks"]))
PY
)"

cd "$ROOT"
bash benchmarks/orchbench/driver.sh \
  --round pg-confirm \
  --tasks "$TASKS" \
  --patterns "$PATTERNS" \
  --balanced-order

bun benchmarks/orchbench/analyze_persuasion_gap.ts \
  --run-prefix orchb-pg-confirm- \
  --json benchmarks/orchbench/persuasion-gap-analysis.json \
  --markdown benchmarks/orchbench/persuasion-gap-analysis.md
