#!/bin/bash
# Records the capture base for one instance's workspace: a commit whose tree is
# the extracted testbed exactly as the official image ships it, before any agent
# runs.
#
#   snapshot-base.sh <workdir>
#
# Every patch this rig captures is `git diff <capture base>`, never
# `git diff <base commit>`. The difference is not cosmetic. The official images
# mutate tracked files in their `pre_install` step — sphinx-doc__sphinx-11445
# seds `-rA` into `tox.ini` — and a diff against the base commit reports that
# churn as if the agent had written it. It then reverse-applies at grading: the
# evaluator's container already carries the churn, `git apply` fails on the
# whole patch, and the `patch --fuzz=5` fallback reads the already-applied hunks
# as a reversal and un-applies the real fix. That defect voided every sphinx
# verdict from waves 2 through 4, on both harnesses.
#
# Anchoring the diff here removes the churn at the source: the base of the final
# diff already contains it, so the patch carries only what the agent changed.
#
# The ref keeps the commit alive against `git gc` and lets `capture-patch.sh`
# and `regen-patch.sh` find it again in a surviving workspace.
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-}"
REF="refs/flows/capture-base"

if [ -z "$WORK" ] || [ ! -d "$WORK/.git" ]; then
  echo "snapshot-base.sh: no git workspace at ${WORK:-<unset>}" >&2; exit 2
fi

source "$S/lib/capture-git.sh"
cd "$WORK"

# Preserve the image's tracked paths and modes in a private index, including
# split-index data when present. Never let host Git use the task's config.
if [ -f "$WORK/.git/index" ]; then
  cp "$WORK/.git/index" "$CAPTURE_GIT/index"
  for shared in "$WORK"/.git/sharedindex.*; do
    [ ! -f "$shared" ] || cp "$shared" "$CAPTURE_GIT/"
  done
fi

# Stage the working tree for every path the image already tracks. In a pristine
# extraction this is a no-op — the images commit their own `pre_install` churn —
# and it is here so an image that leaves the churn merely unstaged is captured
# the same way.
#
# `core.fileMode=false`: `docker cp` to the host does not preserve permission
# bits, so the modes recorded are the image's own, and the host's are ignored.
capture_git add -u

TREE="$(capture_git write-tree)"
COMMIT="$(
  capture_git commit-tree "$TREE" -p "$(capture_git rev-parse HEAD)" \
    -m "swebench: pristine post-install testbed, captured before the agent ran"
)"
capture_git update-ref "$REF" "$COMMIT"
echo "$COMMIT"
