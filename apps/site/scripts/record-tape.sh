#!/bin/sh
# Records tapes/cli.tape against a fresh run state, on the ChatGPT seat.
#
# The tape runs real flows through the working tree's CLI, so it needs a
# provider: SMITHERS_OPENAI_AUTH=chatgpt reads the Codex login, or export
# OPENAI_API_KEY / ANTHROPIC_API_KEY and change the `model:` line of the
# flows. The scratch root is a detached worktree of HEAD, with the checkout
# dependencies linked in, so flows see the source and Git history while run ids
# start at run-1 every time. Only that scratch worktree is removed.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
site="$(dirname "$here")"
repo="$(cd "$site/../.." && pwd)"
export PATH="$site/tapes/bin:$PATH"
export SMITHERS_OPENAI_AUTH="${SMITHERS_OPENAI_AUTH:-chatgpt}"
SMITHERS_TAPE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/smithers-tape.XXXXXX")"
export SMITHERS_TAPE_ROOT
trap 'git -C "$repo" worktree remove --force "$SMITHERS_TAPE_ROOT"; rm -rf "$SMITHERS_TAPE_ROOT"' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$repo" worktree add --detach "$SMITHERS_TAPE_ROOT" HEAD
ln -s "$repo/node_modules" "$SMITHERS_TAPE_ROOT/node_modules"
cd "$repo"
vhs "$site/tapes/cli.tape"
