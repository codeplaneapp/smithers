#!/bin/bash
# Proves `lib/lock.sh` — the one serialization point every lane in this rig
# shares — against the failures that actually happen to it.
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
#   6  two stale reclaimers: a delayed deletion cannot remove a replacement
#      owner after its acquisition has returned
#   7  a killed reclaimer releases the OS guard, without a second stale lock
#
# Each lane is a separate process, because a `( … ) &` subshell shares `$$` with
# the shell that spawned it and the pid in the lock is the whole point.
#
# Spends nothing, needs no docker, needs no dataset. Runs in about a minute.
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

echo "== 6. a delayed stale reclaimer cannot remove a replacement owner"
# Pause a copy of the actual helper at steal's entry, after stale inspection.
# Both owners stay alive until both acquisition results have been observed.
python3 - "$S/lib/lock.sh" "$TMP" <<'PYTEST'
import os
from pathlib import Path
import subprocess
import sys
import time

source, tmp = Path(sys.argv[1]), Path(sys.argv[2])
original = source.read_text()
assert original.count("steal() {") == 1, "stale removal hook moved"
paused = tmp / "paused-lock.sh"
paused.write_text(original.replace("steal() {", """steal() {
  if [ ! -f "$PROBE_DIR/ready" ]; then
    touch "$PROBE_DIR/ready"
    while [ ! -f "$PROBE_DIR/resume" ]; do sleep 0.02; done
  fi
"""))
def wait_for(path, process):
    deadline = time.monotonic() + 5
    while not path.exists():
        assert process.poll() is None, "delayed contender exited before inspection"
        assert time.monotonic() < deadline, "delayed contender never reached pause"
        time.sleep(0.02)


for mode, nonce, kill_replacement in [
    ("acquire", False, False),
    ("acquire", True, False),
    ("reconcile", True, False),
    ("reconcile", True, True),
]:
    case = tmp / f"{mode}-{nonce}-{kill_replacement}"
    case.mkdir()
    lock = case / "lock"
    lock.mkdir()
    dead = subprocess.Popen(["true"])
    dead.wait()
    (lock / "pid").write_text(f"{dead.pid}\n")
    if nonce:
        (lock / "generation").write_text(f"{dead.pid}-old-generation\n")
    owners = [subprocess.Popen(["sleep", "60"]) for _ in range(2)]
    slow = None
    try:
        args = [str(lock), "--timeout", "8", "--poll", "1", "--quiet"]
        slow = subprocess.Popen(
            ["bash", str(paused), mode, *args, "--owner", str(owners[0].pid)],
            env={**os.environ, "PROBE_DIR": str(case)},
            stdout=subprocess.DEVNULL,
        )
        wait_for(case / "ready", slow)
        fast = subprocess.run(
            ["bash", str(source), "acquire", *args, "--owner", str(owners[1].pid)], timeout=12,
        )
        assert fast.returncode == 0, "replacement contender failed to acquire"
        first_owner = (lock / "pid").read_text().strip()
        assert first_owner == str(owners[1].pid)
        generation = (lock / "generation").read_text() if nonce else None
        if kill_replacement:
            owners[1].terminate()
            owners[1].wait()
        (case / "resume").touch()
        slow_status = slow.wait(timeout=12)
        if not kill_replacement:
            assert all(owner.poll() is None for owner in owners), "owners must remain alive"
        if mode == "acquire":
            assert slow_status == 1, f"both live owners were granted the lock (delayed status {slow_status})"
        else:
            assert slow_status == 0, "reconcile should leave the replacement alone"
        assert (lock / "pid").read_text().strip() == first_owner, "delayed reclaimer replaced owner"
        if nonce:
            assert (lock / "generation").read_text() == generation, "replacement generation changed"
        print(f"    passed delayed {mode}: nonce={nonce}, replacement_dead={kill_replacement}")
    finally:
        (case / "resume").touch()
        if slow is not None and slow.poll() is None:
            slow.kill()
            slow.wait()
        for owner in owners:
            if owner.poll() is None:
                owner.terminate()
            owner.wait()

print("== 7. a killed stale reclaimer releases the OS guard")
assert original.count("remove_lock() {") == 1, "guarded removal hook moved"
guarded = tmp / "guarded-lock.sh"
guarded.write_text(original.replace("remove_lock() {", """remove_lock() {
  touch "$PROBE_DIR/ready"
  while [ ! -f "$PROBE_DIR/resume" ]; do sleep 0.02; done
"""))
case = tmp / "guard-death"
case.mkdir()
lock = case / "lock"
lock.mkdir()
(lock / "pid").write_text(f"{dead.pid}\n")
owner = subprocess.Popen(["sleep", "60"])
slow = None
try:
    slow = subprocess.Popen(
        ["bash", str(guarded), "reconcile", str(lock), "--quiet"],
        env={**os.environ, "PROBE_DIR": str(case)},
        stdout=subprocess.DEVNULL,
    )
    wait_for(case / "ready", slow)
    args = ["bash", str(source), "acquire", str(lock), "--owner", str(owner.pid), "--quiet"]
    blocked = subprocess.run([*args, "--timeout", "1"], timeout=5)
    assert blocked.returncode == 1, "acquisition bypassed guarded removal"
    slow.kill()
    slow.wait()
    recovered = subprocess.run([*args, "--timeout", "5", "--poll", "1"], timeout=8)
    assert recovered.returncode == 0, "killed reclaimer left the guard locked"
    assert (lock / "pid").read_text().strip() == str(owner.pid)
    assert Path(f"{lock}.guard").is_file(), "guard file must persist across holders"
finally:
    (case / "resume").touch()
    if slow is not None and slow.poll() is None:
        slow.kill()
        slow.wait()
    owner.terminate()
    owner.wait()
PYTEST
check "$?" "delayed reclaimers preserve replacement generations and guard death is recoverable"

if [ "$FAILURES" -gt 0 ]; then
  echo "check-lock.sh: $FAILURES failure(s)"
  exit 1
fi
echo "check-lock.sh: one lane at a time, a killed holder recovered, no lane frees another's lock,"
echo "  delayed reclaimers are fenced, and a lane that dies waiting takes none."
