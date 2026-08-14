#!/usr/bin/env bash
# Fairness self-test for one RoadmapBench task. Proves the scorer is sound
# BEFORE any agent is trusted on it:
#   1. no-op repo (pristine V_old)      -> reward MUST be < 1.0  (tests really
#                                           exercise the new, unimplemented features)
#   2. oracle repo (V_old + changes.patch) -> reward MUST be == 1.0 (the ground-truth
#                                           solution passes through our path)
#
# Usage: validate_task.sh <task_dir>   where <task_dir> contains
#        task.toml, solution/, tests/  (the HuggingFace task layout)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TASK_DIR="$(cd "${1:?task_dir}" && pwd)"
IMAGE="${RMB_IMAGE_OVERRIDE:-$(awk -F'"' '/docker_image/{print $2; exit}' "$TASK_DIR/task.toml")}"
WORK="${RMB_WORK:-$TASK_DIR/.validate}"
rm -rf "$WORK"; mkdir -p "$WORK"

echo "== task=$(basename "$TASK_DIR") image=$IMAGE =="

# --- extract pristine V_old repo from the official image (source of truth) ---
echo "== extracting pristine /app from image =="
cid="$(docker create --platform linux/amd64 "$IMAGE")"
docker cp "$cid:/app" "$WORK/pristine" >/dev/null
docker rm "$cid" >/dev/null
# Normalize Docker's possible /app wrapper without confusing a real repository
# subdirectory named app/ for that wrapper. Prefer the extracted directory when
# it has repository-root metadata.
if [[ -d "$WORK/pristine/.git" || -f "$WORK/pristine/go.mod" || -f "$WORK/pristine/Cargo.toml" \
   || -f "$WORK/pristine/package.json" || -f "$WORK/pristine/pyproject.toml" \
   || -f "$WORK/pristine/setup.py" || -f "$WORK/pristine/CMakeLists.txt" ]]; then
  mv "$WORK/pristine" "$WORK/repo_pristine"
elif [[ -d "$WORK/pristine/app" ]]; then
  mv "$WORK/pristine/app" "$WORK/repo_pristine"; rm -rf "$WORK/pristine"
else
  mv "$WORK/pristine" "$WORK/repo_pristine"
fi

# Construct the oracle before invoking any test script. score.sh is itself
# snapshot-isolated, but preserving this ordering makes validation robust even
# if a future scorer implementation changes.
echo "== building ORACLE repo (V_old + changes.patch) =="
cp -R "$WORK/repo_pristine" "$WORK/repo_oracle"
( cd "$WORK/repo_oracle" && git apply "$TASK_DIR/solution/changes.patch" 2>/dev/null \
    || git apply --3way "$TASK_DIR/solution/changes.patch" 2>/dev/null \
    || patch -p1 < "$TASK_DIR/solution/changes.patch" )

# --- no-op score ---
echo "== scoring NO-OP (expect < 1.0) =="
NOOP="$(bash "$HERE/score.sh" "$IMAGE" "$WORK/repo_pristine" "$TASK_DIR/tests" "$WORK/out_noop" | tail -1)"
echo "   no-op reward = $NOOP"

# --- oracle score ---
echo "== scoring ORACLE (expect == 1.0) =="
ORACLE="$(bash "$HERE/score.sh" "$IMAGE" "$WORK/repo_oracle" "$TASK_DIR/tests" "$WORK/out_oracle" | tail -1)"
echo "   oracle reward = $ORACLE"

echo
echo "== VERDICT =="
ok=1
python3 -c "import sys; sys.exit(0 if float('$NOOP') < 1.0 else 1)" \
  && echo "  [PASS] no-op < 1.0 ($NOOP)" || { echo "  [FAIL] no-op should be < 1.0 (got $NOOP)"; ok=0; }
python3 -c "import sys; sys.exit(0 if abs(float('$ORACLE')-1.0) < 1e-9 else 1)" \
  && echo "  [PASS] oracle == 1.0 ($ORACLE)" || { echo "  [FAIL] oracle should be 1.0 (got $ORACLE)"; ok=0; }
if [[ $ok != 1 ]]; then
  echo "  SCORER VALIDATION FAILED."
  exit 1
fi
echo "  SCORER IS FAIR AND SOUND for this task."

# Bind the passing verdict to the exact task, hidden tests, harness, image,
# and scoring network policy. Confirmatory runs consume the immutable image ID
# from this receipt rather than trusting the task's mutable Docker tag.
IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
IMAGE_DIGEST="$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE")"
python3 - "$TASK_DIR" "$HERE" "$IMAGE" "$IMAGE_ID" "$IMAGE_DIGEST" "$NOOP" "$ORACLE" "$WORK/validation-receipt.json" <<'PY'
import datetime, hashlib, json, os, pathlib, sys

task_dir, harness_dir, image_ref, image_id, image_digest, noop, oracle, output = sys.argv[1:]

def file_hash(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

def tree_hash(path):
    root = pathlib.Path(path)
    digest = hashlib.sha256()
    for item in sorted(p for p in root.rglob("*") if p.is_file()):
        digest.update(item.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(item.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()

receipt = {
    "schemaVersion": 1,
    "taskId": pathlib.Path(task_dir).name,
    "datasetRevision": os.environ.get("RMB_DATASET_REVISION", "59184e779909300a5a0150b06b945d39da81a099"),
    "imageRef": image_ref,
    "imageId": image_id,
    "imagePinnedRef": image_digest,
    "validationMethod": "direct-v1",
    "scorerNetwork": os.environ.get("RMB_SCORER_NETWORK", "none"),
    "noopReward": float(noop),
    "oracleReward": float(oracle),
    "taskTomlSha256": file_hash(pathlib.Path(task_dir) / "task.toml"),
    "instructionSha256": file_hash(pathlib.Path(task_dir) / "instruction.md"),
    "testsTreeSha256": tree_hash(pathlib.Path(task_dir) / "tests"),
    "solutionTreeSha256": tree_hash(pathlib.Path(task_dir) / "solution"),
    "scoreHarnessSha256": file_hash(pathlib.Path(harness_dir) / "score.sh"),
    "validatorSha256": file_hash(pathlib.Path(harness_dir) / "validate_task.sh"),
    "validatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
pathlib.Path(output).write_text(json.dumps(receipt, indent=2) + "\n")
PY
