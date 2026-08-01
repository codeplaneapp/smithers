#!/usr/bin/env bash
# RoadmapBench scorer — runs the task's hidden test suite against a candidate
# repository inside a FRESH container built from the official task image.
#
# This is the single source of truth for scoring. It is deliberately dumb:
# it mounts the candidate repo at /app and the hidden tests at /tests, then
# runs the task's own tests/test.sh exactly as the benchmark authors wrote it.
# It performs NO interpretation of results beyond extracting reward.json.
#
# Fairness guarantees:
#   - A private snapshot of the candidate repo is mounted read-write at /app
#     (so mutating test/build steps behave like the upstream harness without
#     contaminating the submitted artifact or a later checkpoint).
#   - The hidden tests live OUTSIDE the repo and are only introduced here, at
#     scoring time. The agent never sees them.
#   - reward.json is produced by the task's own test.sh weighted scoring.
#
# Usage:
#   score.sh <image> <repo_dir> <tests_dir> <out_dir>
#
# Writes <out_dir>/reward.json and <out_dir>/test_output.log, prints the
# reward float on the last stdout line.
set -euo pipefail

IMAGE="${1:?image}"
REPO_DIR="$(cd "${2:?repo_dir}" && pwd)"
TESTS_DIR="$(cd "${3:?tests_dir}" && pwd)"
OUT_DIR="${4:?out_dir}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# Copy both the candidate and tests to throwaway directories. Official test
# scripts can run go mod commands, editable installs, code generation, or copy
# hidden test files into /app; none of that may alter the caller's artifact.
REPO_TMP="$(mktemp -d)"
TESTS_TMP=""
trap 'rm -rf "$REPO_TMP" ${TESTS_TMP:+"$TESTS_TMP"}' EXIT
cp -a "$REPO_DIR"/. "$REPO_TMP"/
TESTS_TMP="$(mktemp -d)"
cp -R "$TESTS_DIR"/. "$TESTS_TMP"/

# /logs/verifier is where test.sh writes reward.json / reward.txt.
LOGS_DIR="$OUT_DIR/logs_verifier"
rm -rf "$LOGS_DIR"; mkdir -p "$LOGS_DIR"

echo "[score] image=$IMAGE repo=$REPO_DIR" >&2
# Agents run offline, but several official images omit dependencies introduced
# by the target release and their test.sh legitimately downloads them. Scoring
# can therefore opt into an uncredentialed Docker bridge, matching the official
# suite. The secure default remains offline. The post-run diff/command audit is
# the integrity gate against code added only to fetch an upstream answer during
# grading when access is enabled.
SCORER_NETWORK="${RMB_SCORER_NETWORK:-none}"
docker run --rm --network "$SCORER_NETWORK" \
  --cpus "${RMB_CPUS:-2}" --memory "${RMB_MEMORY:-4096m}" \
  -v "$REPO_TMP":/app \
  -v "$TESTS_TMP":/tests \
  -v "$LOGS_DIR":/logs/verifier \
  "$IMAGE" bash /tests/test.sh >"$OUT_DIR/test_output.log" 2>&1 || true

cp -f "$LOGS_DIR/reward.json" "$OUT_DIR/reward.json" 2>/dev/null || true

if [[ -f "$OUT_DIR/reward.json" ]]; then
  python3 -c "import json,sys; print(json.load(open('$OUT_DIR/reward.json'))['reward'])"
else
  echo "[score] NO reward.json produced; see $OUT_DIR/test_output.log" >&2
  tail -25 "$OUT_DIR/test_output.log" >&2 || true
  echo "0.0"
fi
