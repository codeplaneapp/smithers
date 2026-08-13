#!/bin/sh
# Execute the bundled child workflow with the official Bun binary installed by
# bootstrap-vm.sh (arm64) or run-on-linux-host.sh (x86_64).

set -eu

BUN_PATH="${STEREOS_GUEST_BUN:-/home/agent/.local/bin/bun}"
WORKFLOW_PATH="${STEREOS_GUEST_WORKFLOW:-/home/agent/workspace/.smithers/child-workflow.js}"

[ -x "$BUN_PATH" ] || { echo "guest Bun is missing or not executable: $BUN_PATH" >&2; exit 127; }
[ -r "$WORKFLOW_PATH" ] || { echo "guest child workflow is missing: $WORKFLOW_PATH" >&2; exit 127; }

exec "$BUN_PATH" "$WORKFLOW_PATH"
