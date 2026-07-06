#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${repo_root}/apps/smithers/.env.e2e.local"
env_supplied_anthropic_key=0

if [[ -f "${env_file}" ]]; then
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=' "${env_file}"; then
    env_supplied_anthropic_key=1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

if [[ "${env_supplied_anthropic_key}" != "1" ]]; then
  unset ANTHROPIC_API_KEY
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude agent credential probe failed: claude CLI not found. Install Claude Code and run claude /login or claude setup-token, or set ANTHROPIC_API_KEY in apps/smithers/.env.e2e.local." >&2
  exit 1
fi

probe_status=0
output="$(claude -p "Say OK" --model claude-sonnet-5 2>/tmp/smithers-e2e-claude-probe.err)" || probe_status=$?
if [[ -z "${output//[[:space:]]/}" ]]; then
  echo "Claude agent credential probe failed: claude CLI produced no output. Run claude /login or claude setup-token, or set ANTHROPIC_API_KEY in apps/smithers/.env.e2e.local." >&2
  sed -n '1,20p' /tmp/smithers-e2e-claude-probe.err >&2 || true
  exit 1
fi

if [[ "${probe_status}" != "0" ]] || grep -Eiq 'rate[_ -]?limit|session limit|api_error_status.*429' <<<"${output}"; then
  echo "Claude agent credential probe failed: claude CLI cannot make a usable real call. Run claude /login or claude setup-token, wait for subscription rate-limit reset, or set ANTHROPIC_API_KEY in apps/smithers/.env.e2e.local." >&2
  sed -n '1,20p' /tmp/smithers-e2e-claude-probe.err >&2 || true
  exit 1
fi
