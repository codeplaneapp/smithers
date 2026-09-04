#!/bin/bash
# Proves `lib/lock.sh` — the one serialization point every lane in this rig
# shares — against the five things that actually happen to it.
#
#   fixtures/check-lock.sh
#
# The extraction lock is taken by `run-instance.sh`, `run-instance-codex.sh` and
# the full benchmark's workers alike, and the evaluator lock by `evaluate.sh`
# and `lib/fullbench-instance.sh`. So a defect here is not one lane's: it is two
# multi-gigabyte `docker cp`s on one disk, or two evaluator processes racing the
# same image cleanup, or a benchmark that waits for ever on a lock nobody holds.
#
#   1  mutual exclusion: a second lane waits, and the two never overlap
#   2  a holder killed with -9 does not wedge the rig: the next lane takes the
#      lock back as soon as that pid is gone
#   3  release is by owner: a lane that never held the lock cannot free it —
#      which is what `run-instance.sh` used to do to whoever was extracting
#   4  a bounded wait fails rather than hanging, and says who is holding it
#   5  a lane killed while it is waiting takes no lock: the acquire is a child
#      of that lane and outlives it
#
# Each lane is a separate process, because a `( … ) &` subshell shares `$$` with
# the shell that spawned it and the pid in the lock is the whole point.
#
# Spends nothing, needs no docker, needs no dataset. Runs in about 15 seconds.
set -u
S="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/flows-lock-check-XXXXXX")"
LOCK="$TMP/lock"
TRACE="$TMP/trace.txt"
FAILURES=0

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

check() {
  if [ "$1" = "0" ]; then
    printf '  ok   %s\n' "$2"
  else
    printf '  FAIL %s\n' "$2"
    FAILURES=$((FAILURES + 1))
  fi
}

# One lane: takes the lock, records that it is inside, works, records that it is
# out, releases.
cat > "$TMP/holder.sh" <<EOF
#!/bin/bash
set -u
"$S/lib/lock.sh" acquire "$LOCK" --owner \$\$ --label "\$1" --timeout 60 --poll 1 --quiet || {
  printf 'X %s\n' "\$1" >> "$TRACE"; exit 1; }
printf 'IN %s\n' "\$1" >> "$TRACE"
sleep "\$2"
printf 'OUT %s\n' "\$1" >> "$TRACE"
"$S/lib/lock.sh" release "$LOCK" --owner \$\$ --quiet
EOF
chmod +x "$TMP/holder.sh"

echo "== 1. two lanes, one at a time"
: > "$TRACE"
"$TMP/holder.sh" a 4 &
A=$!
sleep 1
"$TMP/holder.sh" b 1 &
B=$!
wait "$A"; wait "$B"
if [ "$(cat "$TRACE")" = "$(printf 'IN a\nOUT a\nIN b\nOUT b')" ]; then
  check 0 "the second lane waited for the first"
else
  check 1 "the second lane waited for the first"
  sed 's/^/    /' "$TRACE"
fi

echo "== 2. a holder killed with -9 does not wedge the next lane"
: > "$TRACE"
"$TMP/holder.sh" victim 60 &
VICTIM=$!
sleep 2
kill -9 "$VICTIM" 2>/dev/null
wait "$VICTIM" 2>/dev/null
check "$([ -d "$LOCK" ] && echo 0 || echo 1)" "the killed lane left its lock behind"
check "$([ "$("$S/lib/lock.sh" owner "$LOCK")" = "$VICTIM" ] && echo 0 || echo 1)" \
  "and the lock still names it"
START="$(date +%s)"
"$TMP/holder.sh" successor 1 &
wait $! 2>/dev/null
TOOK=$(( $(date +%s) - START ))
check "$(grep -q '^IN successor' "$TRACE" && echo 0 || echo 1)" "the next lane took the lock back"
check "$([ "$TOOK" -le 10 ] && echo 0 || echo 1)" "and took it back promptly (${TOOK}s)"
check "$([ -d "$LOCK" ] && echo 1 || echo 0)" "the lock is free afterwards"

echo "== 3. a lane that does not hold the lock cannot release it"
"$S/lib/lock.sh" acquire "$LOCK" --owner $$ --label "this shell" --quiet
"$S/lib/lock.sh" release "$LOCK" --owner 424242 --quiet >/dev/null 2>&1
check "$([ -d "$LOCK" ] && echo 0 || echo 1)" "a stray release left the live lock alone"
check "$([ "$("$S/lib/lock.sh" owner "$LOCK")" = "$$" ] && echo 0 || echo 1)" "and the owner is unchanged"

echo "== 4. the wait is bounded"
# The waiter needs a live owner of its own: an acquire for a pid that is already
# gone gives up at once, which is test 5.
sleep 30 &
WAITER=$!
START="$(date +%s)"
if "$S/lib/lock.sh" acquire "$LOCK" --owner "$WAITER" --timeout 2 --poll 1 2> "$TMP/timeout.txt"; then
  check 1 "a lock held by a live owner is never stolen"
else
  check 0 "a lock held by a live owner is never stolen"
fi
check "$(grep -q "still held by pid $$" "$TMP/timeout.txt" && echo 0 || echo 1)" \
  "the timeout names who is holding it"
TOOK=$(( $(date +%s) - START ))
check "$([ "$TOOK" -le 8 ] && echo 0 || echo 1)" "and it gave up on time (${TOOK}s)"
kill -9 "$WAITER" 2>/dev/null; wait "$WAITER" 2>/dev/null
"$S/lib/lock.sh" release "$LOCK" --owner $$ --quiet

echo "== 5. a lane killed while it waits leaves no lock behind"
# `lock.sh acquire` is a child of the lane it acquires for, so it outlives a
# lane that is killed mid-wait. Taking the lock for a pid that is already gone
# leaves one nobody will release — self-healing, because the next waiter steals
# a dead owner's lock, but not if that pid has been recycled by then.
: > "$TRACE"
"$TMP/holder.sh" blocker 6 &
BLOCKER=$!
sleep 1
"$TMP/holder.sh" doomed 1 &
DOOMED=$!
sleep 1
kill -9 "$DOOMED" 2>/dev/null
wait "$DOOMED" 2>/dev/null
wait "$BLOCKER" 2>/dev/null
sleep 3
check "$([ -d "$LOCK" ] && echo 1 || echo 0)" "no lock is left behind for the lane that died"
check "$(grep -q '^IN doomed' "$TRACE" && echo 1 || echo 0)" "and it never entered"

if [ "$FAILURES" -gt 0 ]; then
  echo "check-lock.sh: $FAILURES failure(s)"
  exit 1
fi
echo "check-lock.sh: one lane at a time, a killed holder recovered, no lane frees another's lock,"
echo "  and a lane that dies waiting takes none."
