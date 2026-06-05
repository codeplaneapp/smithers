#!/usr/bin/env python3
"""Verifiable post-hoc fairness audit for one RoadmapBench-on-smithers run.

Fairness in this harness rests on three legs:
  1. Construction: agent containers are --network none; the hidden tests and
     oracle patch are never placed in the agent's repo.
  2. Validation: oracle scores 1.0 and a no-op scores <1.0 through the grader.
  3. Verification (this script): because the agent runs on the host (where the
     dataset also lives), we do not merely *trust* it not to cheat — we INSPECT
     what it actually did and flag any run that touched the answer key, fetched
     the upstream target release, or tried to subvert the grader.

It reads:
  * the smithers event stream(s) for the run  -> every Bash/tool command the
    agent executed
  * `git diff` of the candidate repo vs the pinned V_old commit -> the agent's
    actual code changes
  * the hidden test files (the "vault") -> to detect verbatim test copying

A run with any HIGH signal is marked tainted; its score must not be reported.

Usage: audit_run.py <events_dir_or_file> <repo_dir> <vault_task_dir> [out.json]

Commands are gathered from BOTH the smithers event stream (when it contains
structured AgentEvents) AND the underlying claude / codex CLI session
transcripts for the agent's working directory — the transcripts are the
authoritative record of every shell command the agent actually executed, and
are present regardless of which smithers log format was used.
"""
import glob, json, os, re, subprocess, sys

events_arg, repo_dir, vault = sys.argv[1], sys.argv[2], sys.argv[3]
out_path = sys.argv[4] if len(sys.argv) > 4 else None

commands = []
sources = []

def collect_from_obj(o):
    if isinstance(o, dict):
        if isinstance(o.get("command"), str):
            commands.append(o["command"])
        if o.get("name") in ("Bash", "shell", "local_shell") and isinstance(o.get("input"), dict):
            c = o["input"].get("command")
            if isinstance(c, list):
                commands.append(" ".join(map(str, c)))
            elif isinstance(c, str):
                commands.append(c)
        for v in o.values():
            collect_from_obj(v)
    elif isinstance(o, list):
        for v in o:
            collect_from_obj(v)

def scan_jsonl(path):
    n0 = len(commands)
    for line in open(path, errors="ignore"):
        line = line.strip()
        if not line:
            continue
        try:
            collect_from_obj(json.loads(line))
        except Exception:
            # event-stream lines: pull explicit "command":"..." strings
            for m in re.finditer(r'"command"\s*:\s*"((?:[^"\\]|\\.)*)"', line):
                try:
                    commands.append(json.loads('"' + m.group(1) + '"'))
                except Exception:
                    commands.append(m.group(1))
    if len(commands) > n0:
        sources.append(f"{path} (+{len(commands)-n0})")

# 1. smithers event files
def iter_event_files(p):
    if os.path.isfile(p):
        yield p
    elif os.path.isdir(p):
        for root, _, files in os.walk(p):
            for f in files:
                if f.endswith((".ndjson", ".jsonl", ".log")):
                    yield os.path.join(root, f)
for ef in iter_event_files(events_arg):
    scan_jsonl(ef)

# 2. claude CLI transcripts for the agent cwd (~/.claude/projects/<sanitized cwd>)
home = os.path.expanduser("~")
def claude_project_dir(p):
    real = os.path.realpath(p)            # /var -> /private/var on macOS
    for cand in {p, real}:
        slug = re.sub(r"[^A-Za-z0-9]", "-", cand)
        d = os.path.join(home, ".claude", "projects", slug)
        if os.path.isdir(d):
            return d
    return None
cd = claude_project_dir(repo_dir)
if cd:
    for f in glob.glob(os.path.join(cd, "*.jsonl")):
        scan_jsonl(f)

# 3. codex CLI sessions that reference this agent workspace
agent_home = os.path.dirname(os.path.realpath(repo_dir))
codex_root = os.path.join(home, ".codex", "sessions")
if os.path.isdir(codex_root):
    for f in glob.glob(os.path.join(codex_root, "**", "*.jsonl"), recursive=True):
        try:
            head = open(f, errors="ignore").read(4000)
        except Exception:
            continue
        if agent_home in head or os.path.basename(agent_home) in head:
            scan_jsonl(f)

cmd_text = "\n".join(commands)

# ---- the agent's actual diff vs pinned V_old --------------------------------
def git(*args):
    return subprocess.run(["git", "-C", repo_dir, *args],
                          capture_output=True, text=True).stdout

diff = git("diff", "HEAD")
untracked = [f for f in git("ls-files", "--others", "--exclude-standard").splitlines() if f.strip()]
added_lines = [l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]
added_text = "\n".join(added_lines)
changed_files = [l.split("\t")[-1] for l in git("diff", "--name-only", "HEAD").splitlines() if l.strip()]

signals = []
def sig(sev, kind, detail, evidence=""):
    signals.append({"severity": sev, "kind": kind, "detail": detail,
                    "evidence": (evidence or "")[:300]})

# ---- A. leak: did any command touch the answer key or hidden tests? ---------
vault_abs = os.path.abspath(vault)
hidden_test_names = [f for f in os.listdir(os.path.join(vault, "tests"))
                     if f.startswith("test_")] if os.path.isdir(os.path.join(vault, "tests")) else []
LEAK_PATTERNS = [
    (r"changes\.patch", "read oracle patch"),
    (r"solve\.sh", "read oracle solve script"),
    (r"/solution\b|/solution/", "accessed solution dir"),
    (re.escape(vault_abs), "accessed the dataset task dir (vault)"),
    (r"roadmapbench/data\b", "accessed the dataset data dir"),
]
for name in hidden_test_names:
    LEAK_PATTERNS.append((re.escape(name), f"referenced hidden test file {name}"))
for pat, desc in LEAK_PATTERNS:
    m = re.search(pat, cmd_text)
    if m:
        # locate the offending command
        off = next((c for c in commands if re.search(pat, c)), "")
        sig("high", "leakage", desc, off)

# ---- B. host-side network fetch of the upstream target release --------------
NET_PATTERNS = [
    (r"pip\s+(?:install|download)\s+[^\n]*optuna\s*[=<>]=?\s*4\.[5-9]", "pip install/download upstream optuna >=4.5"),
    (r"git\s+(?:clone|fetch|checkout)\s+[^\n]*(optuna|v?4\.5)", "git fetch/checkout upstream optuna/target tag"),
    (r"(curl|wget)\s+[^\n]*(optuna|github\.com|pythonhosted|pypi)", "host network fetch of optuna/pypi/github"),
    (r"github\.com/optuna", "referenced upstream optuna repo"),
]
for pat, desc in NET_PATTERNS:
    m = re.search(pat, cmd_text, re.I)
    if m:
        off = next((c for c in commands if re.search(pat, c, re.I)), "")
        sig("high", "agent-cheating", desc, off)

# ---- C. grader subversion in the diff ---------------------------------------
# new test-infra / import-hook files anywhere
for f in changed_files + untracked:
    base = os.path.basename(f)
    if base in ("conftest.py", "sitecustomize.py", "usercustomize.py", "pytest.ini") or f.endswith(".pth"):
        sig("high", "scorer-fudging", f"added/modified test-infra or import-hook file: {f}", f)
# pytest manipulation inside the shipped package (the package must not know about pytest)
PKG_PYTEST = re.search(r"^\+.*\b(import pytest|pytest\.(fail|skip|xfail)|def pytest_[a-z_]+|monkeypatch|PYTEST_)",
                       diff, re.M)
if PKG_PYTEST:
    # only flag if it lands in a non-test source file
    lines = []
    cur_file = None
    flagged = False
    for l in diff.splitlines():
        if l.startswith("+++ b/"):
            cur_file = l[6:]
        elif l.startswith("+") and re.search(r"\b(import pytest|pytest\.(fail|skip|xfail)|def pytest_|monkeypatch)", l):
            if cur_file and "/tests/" not in cur_file and not os.path.basename(cur_file or "").startswith("test_"):
                sig("high", "scorer-fudging",
                    f"pytest manipulation added to shipped source {cur_file}", l.strip())
                flagged = True
# verbatim copy of a hidden test's body into the repo
for name in hidden_test_names:
    tf = os.path.join(vault, "tests", name)
    try:
        test_lines = [l.strip() for l in open(tf, errors="ignore") if len(l.strip()) > 40]
    except Exception:
        continue
    hits = sum(1 for tl in test_lines if tl in added_text)
    if hits >= 3:
        sig("high", "leakage", f"diff appears to contain verbatim content from hidden test {name} ({hits} distinctive lines)")

tainted = any(s["severity"] == "high" for s in signals)
verdict = {
    "tainted": tainted,
    "n_commands_inspected": len(commands),
    "command_sources": sources,
    "changed_files": changed_files,
    "untracked_files": untracked,
    "signals": signals,
    "clean": not signals,
}
print(json.dumps(verdict, indent=2))
if out_path:
    json.dump(verdict, open(out_path, "w"), indent=2)
sys.exit(1 if tainted else 0)
