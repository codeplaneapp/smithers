#!/bin/sh
# guest-runner.sh — the Smithers sandbox entry runner for a stereOS mixtape.
#
# Mixtapes ship agent harnesses, not Bun or Node, so the entry cannot be the
# usual `bun run-smithers-sandbox.js`. This script is the dependency-free
# alternative: POSIX shell plus coreutils, both present in every mixtape.
#
# Contract (identical to every first-class provider):
#   read  $SMITHERS_SANDBOX_REQUEST_PATH   — request JSON written by the host
#   write $SMITHERS_SANDBOX_RESULT_PATH    — result JSON, also echoed to stdout
#
# The result is `{"status":"finished","output":{...}}`. Everything in `output`
# is measured inside the guest by this script.

set -eu

REQUEST_PATH="${SMITHERS_SANDBOX_REQUEST_PATH:?SMITHERS_SANDBOX_REQUEST_PATH is unset}"
RESULT_PATH="${SMITHERS_SANDBOX_RESULT_PATH:?SMITHERS_SANDBOX_RESULT_PATH is unset}"

# --- read the prompt out of the request -------------------------------------
# jq when the mixtape has it, a sed fallback when it does not.
if command -v jq >/dev/null 2>&1; then
  prompt=$(jq -r '.input.prompt // ""' <"$REQUEST_PATH")
  sandbox_id=$(jq -r '.sandboxId // ""' <"$REQUEST_PATH")
  run_id=$(jq -r '.runId // ""' <"$REQUEST_PATH")
else
  prompt=$(sed -n 's/.*"prompt":"\([^"]*\)".*/\1/p' <"$REQUEST_PATH")
  sandbox_id=$(sed -n 's/.*"sandboxId":"\([^"]*\)".*/\1/p' <"$REQUEST_PATH")
  run_id=$(sed -n 's/.*"runId":"\([^"]*\)".*/\1/p' <"$REQUEST_PATH")
fi

# --- do real work in the guest ----------------------------------------------
# Every value below is produced by the stereOS VM, not by the host.
one_line() { tr -d '"\\' | tr '\n' ' ' | sed 's/  */ /g; s/ *$//'; }

# Guarded by a file test rather than `. /etc/os-release 2>/dev/null && …`:
# `.` is a POSIX special builtin, so a missing file is a fatal error that exits
# a non-interactive shell outright — `&&` and `||` do not catch it. The old form
# aborted the whole runner on any guest without /etc/os-release, which reaches
# the host as the opaque "Sandbox produced no result JSON". Same failure class
# as the `:` redirect noted in real/README.md. The subshell also keeps
# os-release's variables out of the rest of this script.
os_name=$( (if [ -r /etc/os-release ]; then . /etc/os-release; fi
  printf '%s %s' "${NAME:-unknown}" "${VERSION:-}") | one_line)
kernel=$(uname -srm | one_line)
guest_user=$(id -un | one_line)
guest_host=$(hostname | one_line)
uptime_s=$(cut -d' ' -f1 </proc/uptime 2>/dev/null || echo 0)
cpus=$(nproc 2>/dev/null || echo 0)
mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
nix_store=$(if [ -d /nix/store ]; then echo yes; else echo no; fi)
harnesses=$(for h in claude opencode gemini; do command -v "$h" >/dev/null 2>&1 && printf '%s ' "$h"; done | one_line)
[ -n "$harnesses" ] || harnesses="none-on-path"

# Restriction model: the agent user must not be able to write outside its
# workspace, and must not be able to reach the Nix package manager.
#
# Each probe runs in a subshell: a redirection failure on a POSIX special
# builtin exits the shell, so the failing redirect must not be able to take
# this script with it.
probe_write() { (touch "$1") 2>/dev/null; }

if probe_write /etc/stereos-write-probe; then
  rm -f /etc/stereos-write-probe
  write_outside="ALLOWED (unexpected)"
else
  write_outside="denied"
fi
if probe_write "$HOME/workspace/.stereos-write-probe"; then
  rm -f "$HOME/workspace/.stereos-write-probe"
  write_inside="allowed"
else
  write_inside="DENIED (unexpected)"
fi
if command -v nix >/dev/null 2>&1; then
  nix_cli="on PATH"
else
  nix_cli="not on PATH"
fi

# The prompt is the unit of work: echo it back, hashed in the guest so the
# host can prove the guest actually saw it.
prompt_sha=$( (printf '%s' "$prompt" | sha256sum 2>/dev/null || printf '%s' "$prompt" | shasum -a 256) | cut -d' ' -f1)
prompt_echo=$(printf '%s' "$prompt" | one_line)

# --- emit the result ---------------------------------------------------------
cat >"$RESULT_PATH" <<JSON
{
  "status": "finished",
  "output": {
    "summary": "ran inside stereOS as ${guest_user}@${guest_host} on ${kernel}",
    "prompt": "${prompt_echo}",
    "promptSha256": "${prompt_sha}",
    "guest": {
      "os": "${os_name}",
      "kernel": "${kernel}",
      "user": "${guest_user}",
      "hostname": "${guest_host}",
      "uptimeSeconds": ${uptime_s},
      "cpus": ${cpus},
      "memTotalKb": ${mem_kb}
    },
    "restrictions": {
      "writeOutsideWorkspace": "${write_outside}",
      "writeInsideWorkspace": "${write_inside}",
      "nixCli": "${nix_cli}",
      "nixStorePresent": "${nix_store}"
    },
    "harnessesOnPath": "${harnesses}",
    "runId": "${run_id}",
    "sandboxId": "${sandbox_id}"
  }
}
JSON

cat "$RESULT_PATH"
