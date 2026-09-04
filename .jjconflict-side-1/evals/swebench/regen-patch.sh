#!/bin/bash
# Re-derives one instance's model patch from its surviving workspace, without
# re-running the agent. Use after changing what the diff excludes.
#
#   regen-patch.sh <instance_id>
#
# The workspace must carry the capture base `run-instance.sh` records before the
# agent starts. A workspace built before that existed cannot be re-captured
# honestly and the script says so instead of guessing.
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
INSTANCE="${1:-}"
DATASET="${SWB_DATASET:-$S/swb-verified.json}"
node "$S/lib/validate-instance.mjs" "$DATASET" "$INSTANCE" >/dev/null || exit $?
mkdir -p "$S/work" "$S/patches"
WORK_ROOT="$(cd "$S/work" && pwd -P)"
WORK="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1], process.argv[2]))' "$WORK_ROOT" "$INSTANCE")"
if [ "$(dirname "$WORK")" != "$WORK_ROOT" ]; then
  echo "[$INSTANCE] resolved work path escaped $WORK_ROOT"; exit 2
fi
"$S/lib/capture-patch.sh" "$WORK" "$S/patches/$INSTANCE.patch" \
  ':(exclude)flows' ':(exclude).flows' ':(exclude).jj' ':(exclude)agent-run.log' >/dev/null
echo "$INSTANCE $(wc -c < "$S/patches/$INSTANCE.patch" | tr -d ' ') bytes, $(wc -l < "$S/patches/$INSTANCE.patch.untracked" | tr -d ' ') untracked files left out"
