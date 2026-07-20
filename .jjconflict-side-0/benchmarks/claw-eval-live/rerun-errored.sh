#!/usr/bin/env bash
# Resilient gap-fill. Re-runs the non-terminal tasks that errored or nulled in a
# prior batch_results.json (e.g. tasks caught in a transient gateway/quota blip),
# as a fresh batch. Terminal CTB_W0* tasks are excluded (those run via Docker).
# Writes a new batch_results.json under traces_smithers/ for the subset; merge it
# with results/aggregate.py.
#   ./rerun-errored.sh <path-to-batch_results.json> [parallel]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor/Claw-Eval-Live"
RES="${1:?usage: rerun-errored.sh <batch_results.json> [parallel]}"
PAR="${2:-2}"
cd "$VENDOR"
# Temp task dir INSIDE vendor so cwd-relative mock_services/ + tasks/<id>/fixtures resolve.
TMP="$VENDOR/.rerun_$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT
N=$(./.venv/bin/python - "$RES" "$TMP" <<'PY'
import json,sys,os
res=json.load(open(sys.argv[1])); tmp=sys.argv[2]; bad=[]
for r in res:
    tid=r["task_id"]
    if tid.startswith("CTB_W0"): continue
    if r.get("error"): bad.append(tid); continue
    t=(r.get("trials") or [{}])[0].get("task_score")
    if t is None: bad.append(tid)
for tid in bad:
    os.symlink(os.path.abspath(f"tasks/{tid}"), os.path.join(tmp, tid))
print(len(bad))
PY
)
echo "Re-running $N errored/nulled non-terminal tasks ..."
[ "$N" = "0" ] && { echo "nothing to re-run"; exit 0; }
export CLAW_EVAL_MODEL_TIMEOUT_S="${CLAW_EVAL_MODEL_TIMEOUT_S:-300}"
./.venv/bin/liveclaw-500 batch --tasks-dir "$TMP" --config config.smithers.yaml \
  --sandbox-mode local --parallel "$PAR"
