#!/usr/bin/env python3
"""Verify that a fairness receipt still binds the exact grading environment."""

import hashlib
import json
import os
import pathlib
import sys


def file_hash(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_hash(root: pathlib.Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(path for path in root.rglob("*") if path.is_file()):
        digest.update(item.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(item.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: verify_validation_receipt.py <task_dir> <receipt.json>")
    task_dir = pathlib.Path(sys.argv[1]).resolve()
    receipt_path = pathlib.Path(sys.argv[2]).resolve()
    harness = pathlib.Path(__file__).resolve().parent
    receipt = json.loads(receipt_path.read_text())
    expected = {
        "schemaVersion": 1,
        "taskId": task_dir.name,
        "datasetRevision": os.environ.get(
            "RMB_DATASET_REVISION", "59184e779909300a5a0150b06b945d39da81a099"
        ),
        "scorerNetwork": os.environ.get("RMB_SCORER_NETWORK", "none"),
        "taskTomlSha256": file_hash(task_dir / "task.toml"),
        "instructionSha256": file_hash(task_dir / "instruction.md"),
        "testsTreeSha256": tree_hash(task_dir / "tests"),
        "solutionTreeSha256": tree_hash(task_dir / "solution"),
        "scoreHarnessSha256": file_hash(harness / "score.sh"),
    }
    mismatches = []
    if receipt.get("validationMethod") == "direct-v1":
        expected["validatorSha256"] = file_hash(harness / "validate_task.sh")
    elif receipt.get("validationMethod") != "transcript-migration-v1":
        mismatches.append("validationMethod")
    mismatches.extend(key for key, value in expected.items() if receipt.get(key) != value)
    decision = receipt.get("decision", "pass")
    passing = receipt.get("oracleReward") == 1.0 and 0.0 <= receipt.get("noopReward", 1.0) < 1.0
    if decision not in {"pass", "invalid"} or (decision == "pass") != passing:
        mismatches.append("fairnessRewards")
    if mismatches:
        raise SystemExit("receipt mismatch: " + ", ".join(mismatches))

    image_ref = str(receipt["imagePinnedRef"])
    if "@sha256:" not in image_ref:
        raise SystemExit("receipt has no immutable Docker image reference")
    repository = str(receipt["imageRef"]).removesuffix(":latest")
    if not image_ref.startswith(repository + "@sha256:"):
        raise SystemExit("pinned Docker reference does not match the task image repository")
    print(image_ref)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
