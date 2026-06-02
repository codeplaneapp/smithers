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
#   - The candidate repo is mounted read-write at /app (so `pip install -e .`
#     and the test runner behave identically to the upstream harness).
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

# Copy tests to a throwaway dir so the container can mutate /tests (test.sh
# does `rm -rf /tests/tests` and writes __pycache__) without touching the
# canonical dataset copy.
TESTS_TMP="$(mktemp -d)"
cp -R "$TESTS_DIR"/. "$TESTS_TMP"/
trap 'rm -rf "$TESTS_TMP"' EXIT

# /logs/verifier is where test.sh writes reward.json / reward.txt.
LOGS_DIR="$OUT_DIR/logs_verifier"
rm -rf "$LOGS_DIR"; mkdir -p "$LOGS_DIR"

echo "[score] image=$IMAGE repo=$REPO_DIR" >&2
# --network none during scoring too: test.sh runs `pip install -e .` on the
# CANDIDATE repo, so a malicious build script (setup.py / pyproject hook) must
# not be able to fetch the upstream answer at install time. All deps are baked
# into the image, so offline install + tests work (validated: oracle=1.0).
docker run --rm --network none \
  --cpus "${RMB_CPUS:-2}" --memory "${RMB_MEMORY:-4096m}" \
  -v "$REPO_DIR":/app \
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
