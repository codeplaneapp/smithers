#!/bin/sh
# Execute the bundled child workflow with the Bun binary that
# install-guest-runtime.sh copied into the guest.
#
# The launcher constructs no results. It checks the two paths and execs Bun,
# which reads SMITHERS_SANDBOX_REQUEST_PATH and writes
# SMITHERS_SANDBOX_RESULT_PATH itself.

set -eu

BUN_PATH="${STEREOS_GUEST_BUN:-/home/agent/.local/bin/bun}"
WORKFLOW_PATH="${STEREOS_GUEST_WORKFLOW:-$(dirname "$0")/child-workflow.js}"

[ -x "$BUN_PATH" ] || { echo "guest Bun is missing or not executable: $BUN_PATH" >&2; exit 127; }
[ -r "$WORKFLOW_PATH" ] || { echo "guest child workflow is missing: $WORKFLOW_PATH" >&2; exit 127; }

exec "$BUN_PATH" "$WORKFLOW_PATH"
