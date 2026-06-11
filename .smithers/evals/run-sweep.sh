#!/usr/bin/env bash
# Run every seeded-workflow eval suite (dev + holdout) and write reports under
# .smithers/evals/reports/<label>/. Usage: run-sweep.sh <label> [concurrency]
set -u
cd "$(dirname "$0")/../.."

LABEL="${1:?usage: run-sweep.sh <label> [concurrency]}"
CONC="${2:-4}"
OUT=".smithers/evals/reports/$LABEL"
mkdir -p "$OUT"

for f in route-task route-task-holdout backpressure-plan backpressure-plan-holdout \
         context-doctor context-doctor-holdout triage-run triage-run-holdout; do
  wf="${f%-holdout}"
  echo "=== [$LABEL] $f ==="
  bun apps/cli/src/index.js eval ".smithers/workflows/$wf.tsx" \
    --cases ".smithers/evals/$f.jsonl" \
    --suite "$f" \
    --run-label "$LABEL-$(date +%s)" \
    --concurrency "$CONC" \
    --report "$OUT/$f.json" \
    --root /tmp/smithers-eval-root \
    --force 2>&1 | tail -4
done

echo "=== [$LABEL] sweep complete ==="
for f in "$OUT"/*.json; do
  python3 -c "
import json,sys
r = json.load(open('$f'))
s = r['summary']
print(f\"{r['suiteId']:30s} {s['passed']}/{s['total']} passed\")"
done
