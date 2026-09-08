#!/bin/bash
# Sourced by snapshot-base.sh and capture-patch.sh after validating WORK.
# The image and container own WORK/.git. Reuse only repository data, never its
# configuration (including includes/worktree config), hooks or helper settings.
# Keep the private Git directory outside the bind mount and discard it on exit.
WORK="$(cd "$WORK" && pwd -P)"
CAPTURE_GIT="$(mktemp -d /tmp/swebench-capture-git.XXXXXX)"
trap 'rm -rf "$CAPTURE_GIT"' EXIT
cp "$WORK/.git/HEAD" "$CAPTURE_GIT/HEAD"
ln -s "$WORK/.git/objects" "$CAPTURE_GIT/objects"
ln -s "$WORK/.git/refs" "$CAPTURE_GIT/refs"
if [ -f "$WORK/.git/packed-refs" ]; then
  cp "$WORK/.git/packed-refs" "$CAPTURE_GIT/packed-refs"
fi
mkdir "$CAPTURE_GIT/info"
if [ -f "$WORK/.git/info/exclude" ]; then
  cp "$WORK/.git/info/exclude" "$CAPTURE_GIT/info/exclude"
fi

capture_git() {
  # env -i also drops GIT_CONFIG_COUNT/PARAMETERS, GIT_EXTERNAL_DIFF, index and
  # common-dir overrides, loader settings and host credentials. No filter or
  # custom diff driver definitions are loaded; .gitattributes cannot add them.
  env -i PATH="$PATH" TMPDIR="$CAPTURE_GIT" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \
    GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0 \
    GIT_AUTHOR_NAME=swebench-rig GIT_AUTHOR_EMAIL=rig@localhost \
    GIT_COMMITTER_NAME=swebench-rig GIT_COMMITTER_EMAIL=rig@localhost \
    git --git-dir="$CAPTURE_GIT" --work-tree="$WORK" --no-pager \
      -c core.hooksPath=/dev/null -c core.fsmonitor=false \
      -c core.attributesFile=/dev/null -c core.excludesFile=/dev/null \
      -c core.fileMode=false "$@"
}
