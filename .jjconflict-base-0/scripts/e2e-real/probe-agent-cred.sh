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

export SMITHERS_E2E_ENV_SUPPLIED_ANTHROPIC_KEY="${env_supplied_anthropic_key}"
exec bun "${repo_root}/scripts/e2e-real/probe-agent-cred.ts"
