#!/bin/bash
# Builds the subject a wave measures, fingerprints it, and pins it.
#
#   ./preflight.sh            build, check, and pin
#   ./preflight.sh --show     print the pinned fingerprint and exit
#
# Run this once before a wave. It writes `.subject.json`, which every later
# `flows.sh` invocation checks itself against, so a wave that starts on one
# harness and finishes on another stops instead of being reported as one
# measurement.
#
# The build is one package. `packages/cli` is the only package in the loaded
# graph whose compiled output is loaded at all: every `@smthrs/*` package's
# workspace `exports` map points at `./src/*.ts`, so the CLI's dependencies are
# loaded from the working tree and stripped of their types by Node. See
# lib/subject.mjs, which proves that rather than assuming it.
#
# That is why this does not build a filter closure. `pnpm --filter "@smthrs/cli..."
# build --no-bail` builds packages nothing loads, and `--no-bail` lets it report
# success while a package in the middle failed — a green preflight over a subject
# that is part one commit and part another. One package, no `--no-bail`, and a
# non-zero exit is fatal.
#
# Spends no tokens and needs no docker.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$S/../.." && pwd)"
PIN="$S/.subject.json"

if [ "${1:-}" = "--show" ]; then
  [ -f "$PIN" ] || { echo "preflight.sh: nothing pinned; run ./preflight.sh" >&2; exit 1; }
  exec node -e '
    const pinned = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(JSON.stringify(pinned, undefined, 2) + "\n");
  ' "$PIN"
fi

echo "== building the subject: @smthrs/cli"
( cd "$ROOT" && pnpm --filter @smthrs/cli build ) || {
  echo "preflight.sh: the CLI build failed. A wave cannot start: the built subject" >&2
  echo "  would be whatever the last successful build left behind." >&2
  exit 1
}

echo "== fingerprinting the subject"
node "$S/lib/subject.mjs" --check --write "$PIN"
echo
echo "preflight.sh: pinned to $PIN"
echo "  Copy the 'subject' line into the wave report's preconditions. Every"
echo "  flows.sh invocation now refuses to run if the subject moves."
