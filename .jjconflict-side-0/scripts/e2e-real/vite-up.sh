#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/apps/smithers"
APP_PORT="${SMITHERS_REAL_APP_PORT:-5375}"

node_major_minor() {
  "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); console.log(`${major}.${minor}`);'
}

node_is_supported() {
  local version major minor
  version="$(node_major_minor "$1")"
  major="${version%%.*}"
  minor="${version#*.}"

  [[ "$major" -gt 22 ]] || [[ "$major" -eq 22 && "$minor" -ge 12 ]] || [[ "$major" -eq 20 && "$minor" -ge 19 ]]
}

find_supported_node() {
  if command -v node >/dev/null 2>&1 && node_is_supported "$(command -v node)"; then
    command -v node
    return 0
  fi

  local candidate
  for candidate in "$HOME"/.nvm/versions/node/v*/bin/node; do
    [[ -x "$candidate" ]] || continue
    if node_is_supported "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

NODE_BIN="$(find_supported_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: Vite requires Node.js 20.19+ or 22.12+, but no supported node was found." >&2
  exit 60
fi

export PATH="$(dirname "$NODE_BIN"):$PATH"
cd "$APP_DIR"
exec vite --host 127.0.0.1 --port "$APP_PORT" --strictPort
