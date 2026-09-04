#!/bin/bash
# Derives every per-run artifact path for one instance run, on either harness.
#
#   run-paths.sh <flows|codex> <instance_id> [run-index]
#
# Prints `KEY=value` lines for `eval`, so the two run scripts and the matrix
# driver cannot disagree about where a run's artifacts live. It is the one place
# that knows the naming rule:
#
#   no run index  ->  work/<id>          patches/<id>.patch          (today's names)
#   run index rN  ->  work/<id>-rN       patches/<id>-rN.patch
#
# Both spellings are produced by the same run script, so a single instance run
# by hand keeps the names every existing script already reads — `regen-patch.sh`
# and the scorecard's default `--work work` among them — while a matrix run
# carries its index in every artifact it writes.
#
# **The journal archive carries the same suffix as the patch**, so the two
# artifacts a selection is made from always come from one run. Keying the
# archive by `<id>-<index>` while the patch of an unindexed run is `<id>.patch`
# would let a hand run overwrite `journals/<id>-r1/` with a journal belonging to
# a different patch than `patches/<id>-r1.patch`, and the selector would rank
# the pair without anything saying they had come apart.
#
# `RUN_INDEX` is `r1` when no index was given, because a run always has one even
# when its paths do not carry it: the matrix manifest and every log line are
# keyed by `<id>-<index>`, and a nameless run could not be recorded in either.
#
# The instance id and the index are validated here rather than by the caller.
# Both reach a shell path, a docker container name and a docker image name, and
# this script's output is `eval`ed, so a value that is not `<repo>__<issue>` or
# `r<digits>` stops before any of that.
set -euo pipefail

HARNESS="${1:-}"
INSTANCE="${2:-}"
INDEX="${3:-}"
S="$(cd "$(dirname "$0")/.." && pwd)"

case "$HARNESS" in
  flows|codex) ;;
  *) echo "run-paths.sh: harness must be flows or codex, got '${HARNESS}'" >&2; exit 2 ;;
esac

case "$INSTANCE" in
  *__*) ;;
  *) echo "run-paths.sh: instance id must match <repo>__<issue>" >&2; exit 2 ;;
esac
if ! printf '%s' "$INSTANCE" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$'; then
  echo "run-paths.sh: instance id must use only ASCII letters, digits, '.', '_' and '-'" >&2; exit 2
fi

# An absent index keeps today's names; a present one must be `r`, digits, and an
# optional lowercase tag. The tag names a lane rather than a round: the full
# benchmark's flows attempt is `r90`, and the codex attempt the backfill runs
# over the same instances is `r90c`, so the two lanes' artifacts sit side by side
# in the shared roots under one obvious rule instead of a second numbering nobody
# can read. Digits alone still mean a matrix round, and everything that reads a
# round — `select-candidate.mjs`, `fixtures/rehydrate-journals.mjs` — keeps its
# own stricter `r<digits>` rule and ignores a tagged lane.
if [ -z "$INDEX" ]; then
  RUN_INDEX="r1"
  SUFFIX=""
else
  if ! printf '%s' "$INDEX" | grep -Eq '^r[0-9]+[a-z]*$'; then
    echo "run-paths.sh: run index must match r<digits>[<lowercase tag>], got '${INDEX}'" >&2; exit 2
  fi
  RUN_INDEX="$INDEX"
  SUFFIX="-$INDEX"
fi

# The docker container name: the instance id with the characters docker refuses
# in a name folded to hyphens, plus the run index, so two runs of one instance
# can never name the same container.
SLUG="$(printf '%s' "$INSTANCE" | tr '_.' '--')"

# The hidden version-control store. `flows` snapshots the working copy around
# every action, and a colocated jj repository writes those snapshots into the
# task checkout's own `.git`: `git log`, `git log --all -S` and `git fsck` then
# hand the agent its own attempt commits as if they were upstream history.
# `django__django-13346` applied two of them as a fake fix, `django__django-13821`
# `git show`-ed one as evidence, and `pydata__xarray-7229` chased two across
# three frames. Pointing jj at a git repository OUTSIDE the working copy keeps
# every snapshot out of the task repository's refs and out of its object store,
# so both surfaces show only real history — and, as a side effect, `git diff` in
# the checkout works the way an agent expects, because jj no longer writes the
# task repository's index either.
if [ "$HARNESS" = "flows" ]; then
  WORK_ROOT="$S/work"
  VCS_ROOT="$S/work/.vcs"
  PATCH_ROOT="$S/patches"
  TIMINGS_ROOT="$S/timings"
  LOG_ROOT="$S/logs-agent"
  CONTAINER="flowsbench-${SLUG}${SUFFIX}"
else
  WORK_ROOT="$S/work-codex"
  PATCH_ROOT="$S/patches-codex"
  TIMINGS_ROOT="$S/timings-codex"
  LOG_ROOT="$S/logs-codex"
  # The codex harness snapshots nothing, so it needs no store; the key is still
  # printed so both harnesses `eval` the same set of names.
  VCS_ROOT="$S/work-codex/.vcs"
  CONTAINER="codexbench-${SLUG}${SUFFIX}"
fi

printf 'RUN_INDEX=%s\n' "$RUN_INDEX"
printf 'RUN_ID=%s\n' "${INSTANCE}-${RUN_INDEX}"
printf 'SUFFIX=%s\n' "\"$SUFFIX\""
printf 'WORK_ROOT=%s\n' "\"$WORK_ROOT\""
printf 'WORK=%s\n' "\"$WORK_ROOT/${INSTANCE}${SUFFIX}\""
printf 'VCS_ROOT=%s\n' "\"$VCS_ROOT\""
printf 'VCS=%s\n' "\"$VCS_ROOT/${INSTANCE}${SUFFIX}.git\""
printf 'PATCH_ROOT=%s\n' "\"$PATCH_ROOT\""
printf 'PATCH=%s\n' "\"$PATCH_ROOT/${INSTANCE}${SUFFIX}.patch\""
printf 'TIMINGS_ROOT=%s\n' "\"$TIMINGS_ROOT\""
printf 'TIMINGS=%s\n' "\"$TIMINGS_ROOT/${INSTANCE}${SUFFIX}.json\""
printf 'LOG_ROOT=%s\n' "\"$LOG_ROOT\""
printf 'LOG_PREFIX=%s\n' "\"$LOG_ROOT/${INSTANCE}${SUFFIX}\""
printf 'CONTAINER=%s\n' "$CONTAINER"
printf 'JOURNAL_ROOT=%s\n' "\"$S/journals\""
printf 'JOURNAL=%s\n' "\"$S/journals/${INSTANCE}${SUFFIX}\""
