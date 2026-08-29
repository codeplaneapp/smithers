#!/bin/bash
# One lock, owned by a named process, safe to leave behind.
#
#   lib/lock.sh acquire <dir> --owner <pid> [--label text] [--timeout s] [--stale s]
#   lib/lock.sh release <dir> --owner <pid>
#   lib/lock.sh reconcile <dir> [--stale s]
#   lib/lock.sh owner <dir>
#
# The rig serializes two things across concurrent lanes: the multi-gigabyte
# `docker cp` that extracts a testbed (`.extract-lock`), and the official
# evaluator (`.grade-lock`, because concurrent evaluator processes race in the
# post-run image cleanup and lose the report). Both used to be a bare
# `until mkdir <dir>; do sleep 5; done`, which has two defects that a benchmark
# running unattended for days will find:
#
# - **A `kill -9` while the lock is held wedges the rig for ever.** The holder's
#   `trap` never runs, the directory stays, and every later extraction spins on
#   `mkdir` with no timeout. Nothing in the rig ever cleared it.
# - **Release was not ownership-checked.** `run-instance.sh` installed a cleanup
#   trap that `rmdir`ed the shared lock *before* it had taken it, so any run
#   exiting for any reason released whatever run was extracting at that moment,
#   and two multi-gigabyte copies ran at once — the thing the lock exists to
#   stop.
#
# So a lock here is a directory holding the owner's pid, and:
#
# - a waiter that finds a lock whose owner pid is **dead** steals it at once, so
#   a crash costs the next waiter one poll rather than the whole run;
# - a waiter that finds a lock with **no pid file** — one an older copy of
#   `run-instance.sh` took before this helper existed — steals it only once it
#   is older than `--stale`, because liveness cannot be read off it;
# - `release` removes the lock **only when the caller owns it**, so a stray
#   release is a no-op;
# - `acquire` re-reads the pid file after writing it, so of two processes that
#   steal the same dead lock in the same instant exactly one keeps it;
# - and the pid file also immunizes the lock against the old `rmdir` trap still
#   running in another lane: `rmdir` refuses a non-empty directory.
#
# `--timeout` bounds the wait (an hour by default) and exits 1, because a
# caller that fails is recoverable and a caller that blocks for ever is not.
#
# Spends nothing, needs no docker.
set -u

usage() {
  echo "usage: lib/lock.sh acquire|release|reconcile|owner <dir> [--owner pid] [--label text] [--timeout s] [--stale s]" >&2
  exit 2
}

MODE="${1:-}"
DIR="${2:-}"
if [ -z "$MODE" ] || [ -z "$DIR" ]; then usage; fi
shift 2

OWNER=""
LABEL=""
TIMEOUT="${SWB_LOCK_TIMEOUT:-3600}"
STALE="${SWB_LOCK_STALE:-1800}"
POLL="${SWB_LOCK_POLL:-5}"
QUIET=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --owner) OWNER="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --stale) STALE="${2:-}"; shift 2 ;;
    --poll) POLL="${2:-}"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    *) usage ;;
  esac
done

for VALUE in "$TIMEOUT" "$STALE" "$POLL"; do
  case "$VALUE" in
    ''|*[!0-9]*) echo "lock.sh: --timeout, --stale and --poll must be non-negative integers" >&2; exit 2 ;;
  esac
done

note() { if [ "$QUIET" = "0" ]; then printf 'lock.sh: %s\n' "$*" >&2; fi }

# Seconds since the lock directory was created, on either stat.
age_of() {
  MTIME="$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || printf '')"
  case "$MTIME" in
    ''|*[!0-9]*) printf '0'; return 0 ;;
  esac
  printf '%s' "$(( $(date +%s) - MTIME ))"
}

owner_of() { cat "$1/pid" 2>/dev/null || printf ''; }

# True when this lock may be taken from whoever left it: a dead owner, or no
# owner recorded at all and older than the stale window.
stealable() {
  HELD_BY="$(owner_of "$1")"
  case "$HELD_BY" in
    ''|*[!0-9]*)
      if [ "$(age_of "$1")" -ge "$STALE" ]; then
        note "$1 has no owner and is $(age_of "$1")s old — taking it"
        return 0
      fi
      return 1 ;;
  esac
  if kill -0 "$HELD_BY" 2>/dev/null; then return 1; fi
  note "$1 was held by pid $HELD_BY, which is gone — taking it"
  return 0
}

steal() {
  rm -f -- "$1/pid" "$1/label" 2>/dev/null || true
  rmdir "$1" 2>/dev/null || true
}

case "$MODE" in
  acquire)
    case "$OWNER" in
      ''|*[!0-9]*) echo "lock.sh: acquire needs --owner <pid>" >&2; exit 2 ;;
    esac
    WAITED=0
    while :; do
      # This runs as a child of the lane it is acquiring for, and that lane can
      # be killed while this waits. A lock taken for a pid that is already gone
      # is a lock nobody will release: the next waiter does take it back, but
      # only because that pid is dead, and a recycled pid would look alive. So
      # the caller is checked on every pass and again after the lock is taken.
      if ! kill -0 "$OWNER" 2>/dev/null; then
        note "the lane this was acquiring for (pid $OWNER) is gone — not taking $DIR"
        exit 1
      fi
      if mkdir "$DIR" 2>/dev/null; then
        printf '%s\n' "$OWNER" > "$DIR/pid"
        if [ -n "$LABEL" ]; then printf '%s\n' "$LABEL" > "$DIR/label"; fi
        # Settle: a process that stole this lock in the same instant would have
        # replaced the directory, and its pid — not ours — is what is in there.
        sleep 1
        if [ "$(owner_of "$DIR")" != "$OWNER" ]; then
          note "$DIR was taken by pid $(owner_of "$DIR") while we were claiming it — waiting"
          continue
        fi
        if kill -0 "$OWNER" 2>/dev/null; then exit 0; fi
        note "the lane this was acquiring for (pid $OWNER) died as it took $DIR — releasing it"
        steal "$DIR"
        exit 1
      fi
      if stealable "$DIR"; then steal "$DIR"; continue; fi
      if [ "$WAITED" -ge "$TIMEOUT" ]; then
        note "$DIR is still held by pid $(owner_of "$DIR") after ${WAITED}s — giving up"
        exit 1
      fi
      sleep "$POLL"
      WAITED=$((WAITED + POLL))
    done ;;

  release)
    case "$OWNER" in
      ''|*[!0-9]*) echo "lock.sh: release needs --owner <pid>" >&2; exit 2 ;;
    esac
    if [ ! -d "$DIR" ]; then exit 0; fi
    HELD_BY="$(owner_of "$DIR")"
    if [ "$HELD_BY" != "$OWNER" ]; then
      note "$DIR is held by '${HELD_BY:-nobody}', not $OWNER — leaving it alone"
      exit 0
    fi
    rm -f -- "$DIR/pid" "$DIR/label" 2>/dev/null || true
    rmdir "$DIR" 2>/dev/null || true
    exit 0 ;;

  reconcile)
    if [ ! -d "$DIR" ]; then echo "no lock at $DIR"; exit 0; fi
    if stealable "$DIR"; then
      steal "$DIR"
      echo "cleared the stale lock at $DIR"
      exit 0
    fi
    echo "$DIR is held by pid $(owner_of "$DIR") ($(age_of "$DIR")s) — left alone"
    exit 0 ;;

  owner)
    owner_of "$DIR"
    printf '\n'
    exit 0 ;;

  *) usage ;;
esac
