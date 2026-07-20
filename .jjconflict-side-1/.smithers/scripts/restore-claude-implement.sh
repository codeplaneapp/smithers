#!/usr/bin/env bash
set -euo pipefail

cd /Users/williamcory/smithers

run_id="restore-claude-implement-$(date +%Y%m%d%H%M%S)"
bun apps/cli/src/index.js up \
  /Users/williamcory/smithers/.smithers/workflows/restore-claude-implement.tsx \
  --run-id "${run_id}" \
  --root /Users/williamcory/smithers
