#!/bin/sh
# Records tapes/cli.tape against a fresh run state, on the ChatGPT seat.
#
# The tape runs real flows through the working tree's CLI, so it needs a
# provider: SMITHERS_OPENAI_AUTH=chatgpt reads the Codex login, or export
# OPENAI_API_KEY / ANTHROPIC_API_KEY and change the `model:` line of the
# flows. Flow definitions are copied into a scratch --root so the run ids
# in the tape start at run-1 every time. Only that scratch directory is removed.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
site="$(dirname "$here")"
repo="$(cd "$site/../.." && pwd)"
export PATH="$site/tapes/bin:$PATH"
export SMITHERS_OPENAI_AUTH="${SMITHERS_OPENAI_AUTH:-chatgpt}"
SMITHERS_TAPE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/smithers-tape.XXXXXX")"
export SMITHERS_TAPE_ROOT
trap 'rm -rf "$SMITHERS_TAPE_ROOT"' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cp -R "$repo/flows" "$SMITHERS_TAPE_ROOT/flows"
cd "$repo"
vhs "$site/tapes/cli.tape"
