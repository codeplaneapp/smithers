#!/usr/bin/env python3
"""Upgrade legacy fairness markers using their immutable validation transcripts."""

import datetime
import hashlib
import json
import pathlib
import re


ROOT = pathlib.Path(__file__).resolve().parents[2]
CONTEXT = ROOT / ".context" / "orchbench"
DATA = ROOT / ".context" / "roadmapbench" / "data"
HARNESS = ROOT / "benchmarks" / "roadmapbench" / "harness"


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


def receipt_from_transcript(marker: pathlib.Path, decision: str) -> dict | None:
    try:
        parsed = json.loads(marker.read_text())
        if parsed.get("schemaVersion") == 1:
            return None
    except (json.JSONDecodeError, AttributeError):
        pass
    slug = marker.name
    task_dir = DATA / slug
    transcript = CONTEXT / "runs" / f"{slug}-validate.log"
    text = transcript.read_text(errors="replace")
    noop_matches = re.findall(r"no-op reward = ([0-9.]+)", text)
    oracle_matches = re.findall(r"oracle reward = ([0-9.]+)", text)
    digest_matches = re.findall(r"Digest: (sha256:[0-9a-f]{64})", text)
    if not noop_matches or not oracle_matches:
        raise RuntimeError(f"incomplete validation transcript: {slug}")
    if not digest_matches:
        print(f"left legacy marker for digest-less transcript: {slug}")
        return None
    noop, oracle = float(noop_matches[-1]), float(oracle_matches[-1])
    passing = noop < 1.0 and oracle == 1.0
    if (decision == "pass") != passing:
        raise RuntimeError(f"transcript verdict disagrees with marker directory: {slug}")
    legacy_text = marker.read_text()
    if decision == "pass":
        legacy = legacy_text.split()
        if len(legacy) != 2 or float(legacy[0]) != noop or float(legacy[1]) != oracle:
            raise RuntimeError(f"legacy marker/transcript mismatch: {slug}")
    else:
        match = re.fullmatch(r"noop=([0-9.]+) oracle=([0-9.]+)\s*", legacy_text)
        if not match or float(match.group(1)) != noop or float(match.group(2)) != oracle:
            raise RuntimeError(f"legacy invalid marker/transcript mismatch: {slug}")
    image_ref = re.search(r'docker_image\s*=\s*"([^"]+)"', (task_dir / "task.toml").read_text()).group(1)
    repository = image_ref.removesuffix(":latest")
    return {
        "schemaVersion": 1,
        "decision": decision,
        "taskId": slug,
        "datasetRevision": "59184e779909300a5a0150b06b945d39da81a099",
        "imageRef": image_ref,
        "imagePinnedRef": f"{repository}@{digest_matches[-1]}",
        "validationMethod": "transcript-migration-v1",
        "validationTranscriptSha256": file_hash(transcript),
        "scorerNetwork": "bridge",
        "noopReward": noop,
        "oracleReward": oracle,
        "taskTomlSha256": file_hash(task_dir / "task.toml"),
        "instructionSha256": file_hash(task_dir / "instruction.md"),
        "testsTreeSha256": tree_hash(task_dir / "tests"),
        "solutionTreeSha256": tree_hash(task_dir / "solution"),
        "scoreHarnessSha256": file_hash(HARNESS / "score.sh"),
        "validatedAt": datetime.datetime.fromtimestamp(
            transcript.stat().st_mtime, datetime.timezone.utc
        ).isoformat(),
    }


def one(marker: pathlib.Path, decision: str) -> bool:
    receipt = receipt_from_transcript(marker, decision)
    if receipt is None:
        return False
    marker.write_text(json.dumps(receipt, indent=2) + "\n")
    return True


changed = sum(one(marker, "pass") for marker in sorted((CONTEXT / "validated").iterdir()) if marker.is_file())
changed += sum(one(marker, "invalid") for marker in sorted((CONTEXT / "invalidated").iterdir()) if marker.is_file())
print(f"migrated {changed} legacy validation receipt(s)")
