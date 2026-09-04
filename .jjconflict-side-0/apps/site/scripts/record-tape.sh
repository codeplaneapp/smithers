#!/bin/sh
# Records tapes/cli.tape against a fresh run state, on the ChatGPT seat.
#
# The tape runs real flows through the working tree's CLI, so it needs a
# provider: SMITHERS_OPENAI_AUTH=chatgpt reads the Codex login, or export
# OPENAI_API_KEY / ANTHROPIC_API_KEY and change the `model:` line of the
# flows. Run state is isolated under a scratch --root copy so the run ids in
# the tape start at run-1 every time.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
site="$(dirname "$here")"
repo="$(cd "$site/../.." && pwd)"
export PATH="$site/tapes/bin:$PATH"
export SMITHERS_OPENAI_AUTH="${SMITHERS_OPENAI_AUTH:-chatgpt}"
cd "$repo"
rm -rf .flows
vhs "$site/tapes/cli.tape"
