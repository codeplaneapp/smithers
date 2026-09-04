#!/bin/bash
# One screen: what the full benchmark has done, is doing, and will cost.
#
#   ./fullbench-status.sh
#
# Reads `fullbench/manifest.jsonl` and nothing else, so it is safe to run at any
# time against a live driver — including from another session — and it never
# writes. `fullbench.sh` regenerates `fullbench/report.md` at every checkpoint;
# this is the between-checkpoints view.
#
# Spends nothing, needs no docker beyond the free-space probe.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
FB="${FB_DIR:-$S/fullbench}"
MANIFEST="$FB/manifest.jsonl"

if [ ! -f "$MANIFEST" ]; then
  echo "fullbench-status.sh: no benchmark in $FB — start one with ./fullbench.sh"
  exit 1
fi

if [ -f "$FB/driver.pid" ] && kill -0 "$(cat "$FB/driver.pid" 2>/dev/null)" 2>/dev/null; then
  DRIVER="running (pid $(cat "$FB/driver.pid"))"
elif [ -f "$FB/PAUSED" ]; then
  DRIVER="PAUSED — $(head -1 "$FB/PAUSED")"
else
  DRIVER="stopped"
fi

exec node "$S/lib/fullbench-status.mjs" \
  "$MANIFEST" "${SWB_DATASET:-$S/swb-verified.json}" "$DRIVER" "$("$S/lib/disk-free.sh")"
