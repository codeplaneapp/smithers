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
WORK="${1:-}"
REF="refs/flows/capture-base"

if [ -z "$WORK" ] || [ ! -d "$WORK/.git" ]; then
  echo "snapshot-base.sh: no git workspace at ${WORK:-<unset>}" >&2; exit 2
fi

cd "$WORK"

# Stage the working tree for every path the image already tracks. In a pristine
# extraction this is a no-op — the images commit their own `pre_install` churn —
# and it is here so an image that leaves the churn merely unstaged is captured
# the same way.
#
# `core.fileMode=false`: `docker cp` to the host does not preserve permission
# bits, so the modes recorded are the image's own, and the host's are ignored.
git -c core.fileMode=false add -u

TREE="$(git write-tree)"
COMMIT="$(
  GIT_AUTHOR_NAME="swebench-rig" GIT_AUTHOR_EMAIL="rig@localhost" \
  GIT_COMMITTER_NAME="swebench-rig" GIT_COMMITTER_EMAIL="rig@localhost" \
  git commit-tree "$TREE" -p "$(git rev-parse HEAD)" \
    -m "swebench: pristine post-install testbed, captured before the agent ran"
)"
git update-ref "$REF" "$COMMIT"
echo "$COMMIT"
