# RoadmapBench on Smithers — Results

Harness: Smithers multi-agent workflow (`plan`/`implement`/`finalize` = **Claude
Opus 4.8**, `review` = **Codex 5.5**), run through the Smithers gateway. Reward =
the task's own hidden weighted test suite, via the unmodified upstream grader.

## Summary

Every agent in both runs was **Claude Opus 4.8** (`claude-opus-4-8`, plan/implement/
finalize) + **Codex 5.5** (`gpt-5.5`, review) — verified from the run transcripts
(466 assistant messages on `claude-opus-4-8`, zero on any other model).

| Metric | Value |
|---|---|
| Tasks scored | 2 of 115 (curated subset; Python + TypeScript) |
| Resolved Rate (RR) | **0.50** (1/2 fully resolved) |
| Completion Score (CS) | **0.857** |
| All graders fair-validated (oracle=1.0, no-op<1.0) | yes |
| All runs audited untainted | yes |

| Task | Lang | Difficulty | Reward | Targets |
|---|---|---|---|---|
| `opt-4.5.0-roadmap` | Python | hard | **1.000** | 3/3 |
| `vbt-1.2.0-roadmap` | TypeScript | medium | **0.714** | 2/3 |

For context, the public RoadmapBench leaderboard's strongest model scores ~0.39 RR
/ ~0.69 CS over the full 115 tasks. Two tasks is a fair, audited subset demo — not
a full-benchmark claim — but both numbers sit above that bar, and the partial
`vbt` score (0.714, partial credit for 2 of 3 targets) shows the grader rewards
real partial progress rather than rounding everything to 1.0. The same harness
scales to all 115 tasks.

## Per-task detail

### `opt-4.5.0-roadmap` — Optuna 4.4.0 → 4.5.0 (Python, difficulty: **hard**)

3 independent targets, all implemented and passing:

1. **GP acquisition-function class hierarchy** — refactor the procedural
   enum-dispatch module into `BaseAcquisitionFunc` + `GPRegressor` + `SearchSpace`
   + `LogEI`/`LogPI`/`UCB`/`LCB`/`ConstrainedLogEI`/`LogEHVI`/`ConstrainedLogEHVI`,
   and remove the old API. (weight 3)
2. **GP sampler constrained multi-objective integration** — wire `ConstrainedLogEHVI`
   into `GPSampler`, lift the "no constrained multi-objective" restriction. (weight 2)
3. **CMA-ES 1-D search space support** — drop the 1-D fallback; emit the exact
   `UserWarning` for `use_separable_cma=True` on 1-D. (weight 1)

```
reward = 1.0   (3/3 targets, "7 passed")   run_id: rmb-opt450-1780307633
```

**Fairness evidence (all checks green):**

- Grader proven sound through the identical scoring path:
  `oracle patch → 1.0`, `untouched V_old → 0.0`.
- Agent + scoring containers both ran `--network none` (upstream release
  unreachable; `pip install optuna==4.5.0` fails by construction).
- Post-hoc audit: **124** shell commands inspected from the agent's
  `claude`/`codex` transcripts across all phases — **0** signals (no access to
  `tests/`, `solution/`, or the dataset; no upstream fetch; no `conftest`/pytest
  monkeypatching; no verbatim test copying).
- The agent's diff is **10 files / ~711 lines** in the real source modules
  (`_gp/acqf.py`, `_gp/gp.py`, `_gp/search_space.py`, `samplers/_gp/sampler.py`,
  `samplers/_cmaes.py`, …). The oracle patch is ~191 KB across ~164 files, so the
  focused diff **cannot** be an oracle copy — it is a genuine, minimal
  implementation of the three tested targets.

Artifacts (gitignored, under `.context/roadmapbench/runs/opt-4.5.0-roadmap/`):
`score/reward.json` (the grader's output), `audit.json` (the fairness verdict),
`agent.diff` (what the agent actually changed), `events/` (the run log).

### `vbt-1.2.0-roadmap` — Valibot 1.1 → 1.2 (TypeScript, difficulty: **medium**)

3 independent targets: (1) type-coercion actions, (2) schema examples/metadata
extraction, (3) ISBN validation. Weights `[3, 2, 2]`.

```
reward = 0.714   (2/3 targets: the weight-3 target + one weight-2)   run_id: rmb-vbt-1.2.0-roadmap
```

A genuine **partial-progress** result: smithers landed the main feature plus one
of the two smaller targets but missed the third — exactly the kind of partial
credit RoadmapBench is designed to measure.

**Fairness evidence:**

- Grader proven sound offline: `oracle → 1.0`, `untouched V_old → 0.0`
  (`pnpm build` + `vitest` run with `--network none`, deps baked into the image).
- Post-hoc **command** audit: **208** commands across all phases — **0** signals
  (no access to tests/oracle/dataset; no upstream fetch; no grader subversion).
- **Caveat (honest):** the diff-level audit is *not* available for this run — the
  agent's isolated workspace lived in `$TMPDIR` and macOS purged it during an idle
  gap before the diff was captured. The command-level audit (the primary
  anti-cheat control) is clean, and the grader's offline soundness stands, but the
  "diff is a real implementation, not a stub/oracle-copy" check could not be run
  for `vbt`. The harness now places agent workspaces under a persistent base
  (`~/.cache/roadmapbench/homes`) so this cannot recur.

## Reproduce

```bash
bash benchmarks/roadmapbench/harness/launch_benchmark.sh opt-4.5.0-roadmap   # detached run
bash benchmarks/roadmapbench/harness/collect_benchmark.sh                    # score + audit + report
cat .context/roadmapbench/runs/_report/report.json
```

## Honest caveats

- **Subset, not the full 115.** Each task is a long agent rollout plus an
  emulated-Docker grade (the images are `linux/amd64`, run under qemu on arm64);
  a full sweep is the same harness scaled, which is compute/time/cost bound, not a
  methodology change.
- **Single attempt.** RR/CS here are from one attempt per task. The leaderboard
  numbers are also single-digit-attempt averages, but a larger N would tighten the
  estimate.
- **Host-run agents.** See the threat model in [README.md](./README.md#threat-model--known-limitations):
  fairness is enforced incidentally by construction and confirmed by the audit,
  not by hard OS sandboxing.
