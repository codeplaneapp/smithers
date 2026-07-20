#!/usr/bin/env python3
"""Merge the local (non-terminal) and Docker (CTB_W*) batch results into one fair
score table for the Smithers run.

The benchmark's "Overall Completion Score" is the mean of per-task `completion`
(== task_score for single-trial runs), scaled to 0-100 — the same number the
public leaderboard reports (Claude Opus 4.6 = 83.6, GPT-5.4 = 81.7).

Usage:
  aggregate.py --local <local/batch_results.json> --docker <dockerW/batch_results.json>

For the 5 terminal tasks (CTB_W0*) we take the Docker result (correct grading);
for all other tasks we take the local result.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path


def family(task_id: str) -> str:
    m = re.match(r"CTB_([A-Z]+)", task_id)
    return m.group(1) if m else "?"


def task_score(r: dict) -> float | None:
    """Per-task completion score (single trial) or None if errored/null."""
    if r.get("error"):
        return None
    trials = r.get("trials") or []
    vals = [t.get("task_score") for t in trials if t.get("task_score") is not None]
    if not vals:
        return None
    return sum(vals) / len(vals)


def load(path: str) -> dict[str, dict]:
    data = json.loads(Path(path).read_text())
    return {r["task_id"]: r for r in data}


def main() -> None:
    ap = argparse.ArgumentParser()
    # Accept multiple local result files (main run + gap-fill re-runs); for each
    # task, a later file with a real (non-errored, non-null) score overrides an
    # earlier errored/nulled one.
    ap.add_argument("--local", required=True, nargs="+")
    ap.add_argument("--docker", required=True)
    ap.add_argument("--out", default=str(Path(__file__).parent / "summary.json"))
    args = ap.parse_args()

    docker = load(args.docker)

    merged: dict[str, dict] = {}
    for path in args.local:
        for tid, r in load(path).items():
            if tid.startswith("CTB_W0"):
                continue  # terminal task -> use Docker result instead
            prev = merged.get(tid)
            # keep a scored result over an errored one; otherwise later file wins
            if prev is None or task_score(r) is not None or task_score(prev["result"]) is None:
                merged[tid] = {"result": r, "mode": "local"}
    for tid, r in docker.items():
        if tid.startswith("CTB_W0"):
            merged[tid] = {"result": r, "mode": "docker"}

    rows = []
    fam_scores: dict[str, list[float]] = defaultdict(list)
    scored, passed, errored = 0, 0, 0
    score_sum = 0.0
    for tid in sorted(merged):
        r = merged[tid]["result"]
        s = task_score(r)
        rows.append({"task_id": tid, "family": family(tid), "score": s,
                     "passed": (s is not None and s >= 0.75), "mode": merged[tid]["mode"]})
        if s is None:
            errored += 1
            continue
        scored += 1
        score_sum += s
        if s >= 0.75:
            passed += 1
        fam_scores[family(tid)].append(s)

    overall_completion = (score_sum / scored) if scored else 0.0
    pass_rate = (passed / scored) if scored else 0.0

    fam_table = {f: {"n": len(v), "avg": round(sum(v) / len(v), 4),
                     "pass": sum(1 for x in v if x >= 0.75)}
                 for f, v in sorted(fam_scores.items())}

    summary = {
        "total_tasks": len(merged),
        "scored": scored,
        "errored": errored,
        "passed": passed,
        "pass_rate": round(pass_rate, 4),
        "overall_completion_score": round(overall_completion * 100, 2),  # leaderboard scale
        "mean_completion": round(overall_completion, 4),
        "by_family": fam_table,
        "rows": rows,
    }
    Path(args.out).write_text(json.dumps(summary, indent=2))

    print(f"Tasks merged:           {len(merged)} (local non-W + 5 docker W)")
    print(f"Scored / errored:       {scored} / {errored}")
    print(f"Passed (>=0.75):        {passed}/{scored}  ({pass_rate*100:.1f}%)")
    print(f"OVERALL COMPLETION:     {overall_completion*100:.2f}  (leaderboard scale; Opus 4.6=83.6, GPT-5.4=81.7)")
    print()
    print(f"{'family':10s} {'n':>3s} {'avg':>6s} {'pass':>5s}")
    for f, d in fam_table.items():
        print(f"{f:10s} {d['n']:>3d} {d['avg']*100:>6.1f} {d['pass']:>3d}/{d['n']}")
    if errored:
        print(f"\nERRORED tasks ({errored}): " + ", ".join(r["task_id"] for r in rows if r["score"] is None))
    print(f"\nWrote {args.out}")


if __name__ == "__main__":
    main()
