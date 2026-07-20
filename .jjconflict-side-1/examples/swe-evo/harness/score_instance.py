#!/usr/bin/env python3
"""Hermetic SWE-EVO instance scorer.

Given one SWE-EVO instance and a candidate patch, this runs the *official*
evaluation: inside the instance's prebuilt Docker image (repo already at
``base_commit``), it applies the candidate patch, restores the test files to
their pristine state, applies the instance's ``test_patch``, runs the instance's
``test_cmds`` over the relevant test files, parses the pytest log with the
instance's named parser, and computes the two SWE-EVO metrics exactly as defined
in the paper (arXiv:2512.18470):

    Resolved(i) = 1 iff every test in FAIL_TO_PASS and PASS_TO_PASS PASSES, else 0

    FixRate(i)  = |{t in FAIL_TO_PASS : t passes}| / |FAIL_TO_PASS|
                  if every PASS_TO_PASS test passes (regression gate), else 0

Fairness guarantees (no mocks, no fudging):
  * The agent's candidate patch is the *only* code input. The gold ``patch`` is
    never used here.
  * Test files are reverted to base before the official ``test_patch`` is applied,
    so a candidate cannot pass by editing tests.
  * Tests run in the real per-instance image with the real dependency set.
  * The log parser is the verbatim SWE-bench/SWE-EVO parser (see parsers.py).

Output: a JSON object on stdout (and to --out if given).
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

from parsers import PARSERS, TestStatus

PASS_STATUSES = {TestStatus.PASSED.value, TestStatus.XFAIL.value}


def test_files_for(instance):
    files = set()
    for t in list(instance["FAIL_TO_PASS"]) + list(instance["PASS_TO_PASS"]):
        files.add(t.split("::", 1)[0])
    return sorted(files)


EVAL_SCRIPT = r"""
set -uo pipefail
cd /testbed
git config --global --add safe.directory /testbed >/dev/null 2>&1 || true

# Start from a clean base tree (the image is committed at base_commit, but be safe).
git checkout -- . >/dev/null 2>&1 || true

echo '___SWEEVO_APPLY_CANDIDATE___'
if [ -s /tmp/candidate.patch ]; then
  if git apply -v /tmp/candidate.patch 2>&1; then echo '___CANDIDATE_OK_git___';
  elif git apply -v --3way /tmp/candidate.patch 2>&1; then echo '___CANDIDATE_OK_3way___';
  elif patch --batch --fuzz=5 -p1 -i /tmp/candidate.patch 2>&1; then echo '___CANDIDATE_OK_patch___';
  else echo '___CANDIDATE_FAILED___'; fi
else
  echo '___CANDIDATE_EMPTY___'
fi

# Anti-cheat: restore the test files to base, then apply the official test_patch,
# so the candidate cannot influence the tests being scored.
echo '___APPLY_TESTS___'
if [ -s /tmp/test_files.txt ]; then
  while IFS= read -r f; do [ -n "$f" ] && git checkout -- "$f" >/dev/null 2>&1 || true; done < /tmp/test_files.txt
fi
if [ -s /tmp/test.patch ]; then
  if git apply -v /tmp/test.patch 2>&1; then echo '___TESTPATCH_OK___';
  elif git apply -v --3way /tmp/test.patch 2>&1; then echo '___TESTPATCH_OK_3way___';
  else echo '___TESTPATCH_FAILED___'; fi
fi

# Activate the prebuilt conda env used by SWE-bench images.
for act in /opt/miniconda3/bin/activate /opt/conda/bin/activate /root/miniconda3/bin/activate; do
  if [ -f "$act" ]; then source "$act" testbed >/dev/null 2>&1 && break; fi
done
command -v conda >/dev/null 2>&1 && conda activate testbed >/dev/null 2>&1 || true

echo '___RUN_TESTS___'
eval "__TEST_CMD__ $(cat /tmp/test_files.txt | tr '\n' ' ')" 2>&1
echo '___DONE___'
"""


def run(instance, patch_text, timeout_s, platform):
    parser_name = instance["log_parser"]
    if parser_name not in PARSERS:
        raise SystemExit(f"unknown log_parser {parser_name!r}; have {list(PARSERS)}")
    parser = PARSERS[parser_name]
    tfiles = test_files_for(instance)

    workdir = tempfile.mkdtemp(prefix="sweevo-score-")
    with open(os.path.join(workdir, "candidate.patch"), "w") as f:
        f.write(patch_text or "")
    with open(os.path.join(workdir, "test.patch"), "w") as f:
        f.write(instance.get("test_patch") or "")
    with open(os.path.join(workdir, "test_files.txt"), "w") as f:
        f.write("\n".join(tfiles) + ("\n" if tfiles else ""))
    script = EVAL_SCRIPT.replace("__TEST_CMD__", instance["test_cmds"])
    with open(os.path.join(workdir, "eval.sh"), "w") as f:
        f.write(script)

    cmd = [
        "docker", "run", "--rm", "--platform", platform,
        "-v", f"{workdir}/candidate.patch:/tmp/candidate.patch:ro",
        "-v", f"{workdir}/test.patch:/tmp/test.patch:ro",
        "-v", f"{workdir}/test_files.txt:/tmp/test_files.txt:ro",
        "-v", f"{workdir}/eval.sh:/tmp/eval.sh:ro",
        instance["image"],
        "bash", "/tmp/eval.sh",
    ]
    t0 = time.time()
    timed_out = False
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
        log = proc.stdout + "\n" + proc.stderr
    except subprocess.TimeoutExpired as e:
        timed_out = True
        # TimeoutExpired.stdout/stderr come back as bytes even with text=True,
        # so decode each part before concatenating (str + bytes raises TypeError).
        def _as_text(x):
            if x is None:
                return ""
            return x.decode("utf-8", "replace") if isinstance(x, (bytes, bytearray)) else x
        log = _as_text(e.stdout) + "\n" + _as_text(e.stderr)
    duration = time.time() - t0

    candidate_applied = ("___CANDIDATE_OK_" in log) or ("___CANDIDATE_EMPTY___" in log)
    testpatch_applied = "___TESTPATCH_OK" in log or not (instance.get("test_patch") or "")

    status_map = parser(log, None)

    def status_of(test):
        return status_map.get(test, "MISSING")

    f2p = list(instance["FAIL_TO_PASS"])
    p2p = list(instance["PASS_TO_PASS"])
    f2p_status = {t: status_of(t) for t in f2p}
    p2p_status = {t: status_of(t) for t in p2p}

    f2p_passed = [t for t in f2p if f2p_status[t] in PASS_STATUSES]
    p2p_passed = [t for t in p2p if p2p_status[t] in PASS_STATUSES]
    all_p2p_pass = len(p2p_passed) == len(p2p)
    all_f2p_pass = len(f2p_passed) == len(f2p)

    # Paper metrics.
    resolved = 1 if (all_f2p_pass and all_p2p_pass) else 0
    if not all_p2p_pass:
        fix_rate = 0.0
    else:
        fix_rate = (len(f2p_passed) / len(f2p)) if f2p else (1.0 if all_p2p_pass else 0.0)

    result = {
        "instance_id": instance["instance_id"],
        "repo": instance["repo"],
        "image": instance["image"],
        "log_parser": parser_name,
        "test_cmds": instance["test_cmds"],
        "resolved": resolved,
        "fix_rate": round(fix_rate, 6),
        "f2p_total": len(f2p),
        "f2p_passed": len(f2p_passed),
        "p2p_total": len(p2p),
        "p2p_passed": len(p2p_passed),
        "all_p2p_pass": all_p2p_pass,
        "candidate_applied": candidate_applied,
        "testpatch_applied": testpatch_applied,
        "timed_out": timed_out,
        "duration_s": round(duration, 1),
        "f2p_status": f2p_status,
        # P2P statuses can be thousands of entries; only surface the failures.
        "p2p_failures": {t: s for t, s in p2p_status.items() if s not in PASS_STATUSES},
        "parsed_test_count": len(status_map),
    }
    return result, log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", required=True, help="path to instance JSON")
    ap.add_argument("--patch", required=True, help="path to candidate patch file")
    ap.add_argument("--out", help="write result JSON here")
    ap.add_argument("--log-out", help="write raw test log here")
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--platform", default="linux/amd64")
    args = ap.parse_args()

    instance = json.load(open(args.instance))
    patch_text = open(args.patch).read() if os.path.exists(args.patch) else ""

    result, log = run(instance, patch_text, args.timeout, args.platform)
    if args.log_out:
        with open(args.log_out, "w") as f:
            f.write(log)
    out = json.dumps(result, indent=2)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out)
    print(out)


if __name__ == "__main__":
    main()
