#!/bin/bash
# Proves the harness's own snapshots never reach the task repository.
#
#   fixtures/check-hidden-vcs.sh
#
# `flows` snapshots the working copy around every action through its `Jj` layer.
# For five waves the rig gave it a COLOCATED jj repository, so every settlement
# landed in the task checkout's own `.git`: jj moved git's HEAD onto the
# settlement commit and exported one `refs/jj/keep/*` ref per visible change.
# `git log`, `git log --all -S` and `git fsck` then handed the agent its own
# attempt commits as if they were upstream history. `django__django-13346`
# applied two of them as a fake fix (~$0.54), `pydata__xarray-7229` chased two
# across three frames (~$0.20), and `django__django-13821` `git show`-ed one as
# evidence (~$0.06).
#
# `run-instance.sh` now points jj at a bare git repository outside the working
# copy. This asserts the property that fix exists for, on a real jj, without
# docker, a dataset, or a token: after a snapshot cycle the task repository's
# refs, HEAD, `git log --all`, `git log --all -S` and `git fsck` are exactly
# what they were before jj was ever initialized, and the scaffolding the rig
# writes is not snapshotted at all.
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v jj >/dev/null 2>&1; then
  echo "check-hidden-vcs: jj is not installed; skipping" >&2
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
WORK="$TMP/work"
VCS="$TMP/vcs.git"

mkdir -p "$WORK/src"
cd "$WORK"
git init --quiet .
printf 'def widen(value):\n    return value\n' > src/units.py
git add -A
GIT_AUTHOR_NAME=upstream GIT_AUTHOR_EMAIL=upstream@localhost \
  GIT_COMMITTER_NAME=upstream GIT_COMMITTER_EMAIL=upstream@localhost \
  git commit --quiet -m "upstream: the task commit"

BEFORE_REFS="$(git show-ref | sort)"
BEFORE_HEAD="$(git rev-parse HEAD)"
BEFORE_LOG="$(git log --all --oneline)"

# Exactly what run-instance.sh does, in the same order.
mkdir -p "$WORK/.flows" "$WORK/flows"
printf 'journal bytes\n' > "$WORK/.flows/engine.db"
printf 'the task\n' > "$WORK/flows/flow.mdx"
printf 'agent log\n' > "$WORK/agent-run.log"
printf 'flows/\n.flows/\n.jj/\nagent-run.log\n' >> "$WORK/.git/info/exclude"
git init --bare --quiet "$VCS"
printf 'flows/\n.flows/\nagent-run.log\n' > "$VCS/flows-excludes"
git -C "$VCS" config core.excludesFile "$VCS/flows-excludes"
jj git init --git-repo="$VCS" >/dev/null 2>&1

# Two settlement snapshots with the message the engine writes, and an edit
# between them, which is the shape every attempt takes.
jj describe -m "flows action key1_abc attempt 1" --quiet
FIRST="$(jj log -r @ --no-graph -T 'change_id.short()')"
jj new --quiet
printf 'def widen(value):\n    return _widen(value)\n' > src/units.py
jj describe -m "flows action key1_abc attempt 1 settled" --quiet
jj new --quiet

fail() {
  echo "check-hidden-vcs: $1" >&2
  exit 1
}

# 1. The task repository is byte-for-byte where it was.
[ "$(git show-ref | sort)" = "$BEFORE_REFS" ] || fail "jj wrote refs into the task repository"
[ "$(git rev-parse HEAD)" = "$BEFORE_HEAD" ] || fail "jj moved the task repository's HEAD"
[ "$(git log --all --oneline)" = "$BEFORE_LOG" ] || fail "git log --all surfaces a harness commit"

# 2. The two surfaces an agent actually mines say nothing about the harness.
if git log --all --oneline | grep -q "flows action"; then fail "git log --all names a flows action commit"; fi
if git log --all -S "_widen" --oneline -- src/units.py | grep -q .; then
  fail "git log --all -S finds the agent's own edit as history"
fi
if git fsck 2>&1 | grep -q .; then fail "git fsck reports harness objects: $(git fsck 2>&1 | head -1)"; fi

# 3. `git diff` works, which a colocated jj took away by writing git's index.
git diff --quiet && fail "git diff reports nothing for an edit that is on disk"
git diff --name-only | grep -qx "src/units.py" || fail "git diff does not name the edited file"

# 4. The snapshots are real: restoring the first one puts the tree back.
jj restore --from "$FIRST" >/dev/null 2>&1
grep -q "return value" src/units.py || fail "the hidden store cannot restore a snapshot"

# 5. The scaffolding is not snapshotted, so a growing journal is not re-hashed
#    into the store on every action.
TRACKED="$(jj file list 2>/dev/null || jj files 2>/dev/null)"
printf '%s\n' "$TRACKED" | grep -q "src/units.py" || fail "jj is not tracking the source tree"
if printf '%s\n' "$TRACKED" | grep -qE "^(\.flows/|flows/|agent-run\.log)"; then
  fail "jj snapshotted the harness scaffolding"
fi

echo "check-hidden-vcs: ok — the task repository shows only upstream history"
