# RoadmapBench on Smithers

[RoadmapBench](https://github.com/UniPat-AI/RoadmapBench) evaluates **long-horizon,
multi-target software development** — agents start from a repository pinned to an
old release (`V_old`) and must implement the multiple independent features that a
real upstream version upgrade introduced. The median oracle change is ~3,700 lines
across ~51 files; tasks have a median of 5 independently-scored targets. SOTA is
unsolved territory: the best single agent on the official leaderboard resolves
under 40% of tasks.

This directory runs RoadmapBench against a **Smithers multi-agent workflow** that
mixes **Claude Opus 4.8** and **Codex 5.5**, and scores it with the benchmark's
own hidden test suites — no mocks, no shortcuts.

## What runs

`.smithers/workflows/roadmapbench.tsx` is a four-stage `Sequence`:

| Stage | Model | Role |
|-------|-------|------|
| `plan` | Opus 4.8 | Explore the repo, decompose the roadmap into its targets, choose an approach |
| `implement` | Opus 4.8 | Implement every target end-to-end, self-checking via the project's own tests |
| `review` | **Codex 5.5** | Independent adversarial review of each target vs the spec; fix defects |
| `finalize` | Opus 4.8 | Final completeness + backward-compat pass; the RoadmapBench scorer runs here |

Each agent works directly in a checkout of `V_old` and can build/run/test code in
the task's real toolchain (the official Docker image) via `docker exec`. The
result is graded by the task's **hidden** per-target tests.

## Fairness — how we keep the numbers honest

The whole point of this exercise was a *fair* benchmark. Three independent legs:

1. **Construction.** The agent only ever sees the `V_old` repo and the roadmap
   (`instruction.md`, embedded directly in the prompt). The hidden tests and the
   oracle patch are **never** placed in, or adjacent to, the agent's workspace —
   the repo lives in an isolated temp dir with nothing else around it, so there is
   no on-disk breadcrumb to the answer key (`harness/prepare_task.sh`). Both the
   agent container and the scoring container run with **`--network none`**, so it
   is physically impossible to `pip install`/`git fetch` the upstream target
   release to obtain the answer (all build & test deps are baked into the image).

2. **Validation.** Before any agent score is trusted, `harness/validate_task.sh`
   proves the grader is sound for that task by running it through the *identical*
   scoring path: the **oracle patch must score 1.0** and an **untouched repo must
   score < 1.0**. If either fails, the task is not reported.

3. **Verification.** Because the agents run on the host (where the LLM APIs are
   reachable), we do not merely *trust* them. `harness/audit_run.py` inspects
   **every shell command the agent actually executed** — read directly from the
   `claude`/`codex` CLI session transcripts (the authoritative record) as well as
   the smithers event stream — together with the **final `git diff`**. It flags
   any attempt to read the tests/oracle/dataset, fetch the upstream release, or
   subvert the grader (e.g. `conftest.py` tricks, monkeypatching pytest, copying
   test bodies, stubbing). A run with any high-severity signal is marked
   **tainted** and excluded from the reported Resolved Rate / Completion Score.

The reward itself is produced by the task's own `tests/test.sh` weighted scoring
(`harness/score.sh` just runs it in a fresh container) — we never reinterpret or
inflate it.

### Threat model / known limitations

- Agents execute on the host rather than fully sandboxed inside the task
  container (which would conflict with giving them LLM egress). Leakage is
  prevented *incidentally* by construction and *verified absent* post-hoc by the
  audit. A production hardening would run the agent inside the container behind an
  egress proxy that allows the LLM API but blocks package indexes / source hosts.
- Some RoadmapBench targets are graded by structural tests; a determined adversary
  could in principle pass them with stubs. This is a property of the upstream
  benchmark (it affects every model equally); the audit + manual diff inspection
  guard against it, and we report the canonical reward.

## Running it

Prerequisites: Docker running; repo deps installed (`bun install`); an
authenticated `claude` CLI and `codex` CLI; `uv` (for the HuggingFace pull). The
official Docker images and the hidden tests are pulled on demand into
`.context/roadmapbench/` (gitignored).

```bash
# 1. launch: per task — validate the grader is fair, prepare an isolated offline
#    workspace, and start the workflow DETACHED through the smithers engine/gateway.
#    Returns immediately; records run ids in .context/roadmapbench/runs/_runlist.tsv
bash benchmarks/roadmapbench/harness/launch_benchmark.sh opt-4.5.0-roadmap

# 2. collect (safe to re-run; finalizes whatever has finished): read the reward
#    from the official grader, audit every command + the diff, aggregate RR/CS.
bash benchmarks/roadmapbench/harness/collect_benchmark.sh

# report: .context/roadmapbench/runs/_report/report.json  (RR + CS + per-task audit)
```

The building blocks can also be run on their own — see each file's header:

```bash
# prove a task's grader is sound (oracle must score 1.0, no-op must score < 1.0):
bash benchmarks/roadmapbench/harness/validate_task.sh .context/roadmapbench/data/opt-4.5.0-roadmap
# score an arbitrary candidate repo with the official grader:
bash benchmarks/roadmapbench/harness/score.sh <image> <repo_dir> <tests_dir> <out_dir>
# audit a finished run for leakage / upstream-fetch / grader subversion:
python3 benchmarks/roadmapbench/harness/audit_run.py <events_dir> <repo_dir> <task_dir> [out.json]
```

## Metrics

- **Resolved Rate (RR):** fraction of (untainted) tasks fully completed (reward = 1.0).
- **Completion Score (CS):** mean per-task reward, crediting partial progress —
  each target's pass/fail is weighted by implementation complexity, exactly as the
  upstream benchmark defines.

## Results

See [RESULTS.md](./RESULTS.md). Curated 2-task subset (Python + TypeScript), every
agent on **Opus 4.8 + Codex 5.5**, every grader fair-validated, every run audited
untainted:

| Task | Lang | Difficulty | Reward | Targets |
|---|---|---|---|---|
| `opt-4.5.0-roadmap` | Python | hard | **1.000** | 3/3 |
| `vbt-1.2.0-roadmap` | TypeScript | medium | **0.714** | 2/3 |

**Resolved Rate 0.50, Completion Score 0.857.** The public leaderboard's best
model is ~0.39 RR / ~0.69 CS over the full 115-task set; both subset numbers sit
above that bar, and `vbt`'s partial 0.714 shows the grader credits real partial
progress. This is a fair, audited subset demo — the same harness scales to all 115.
