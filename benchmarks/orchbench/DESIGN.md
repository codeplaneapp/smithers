# OrchBench — orchestration-pattern cost/speed/quality benchmark

**Question.** Which multi-agent orchestration pattern delivers the highest
quality per dollar and per hour on long-horizon coding tasks, and where do
returns diminish?

**Method.** Hold the benchmark task, workspace, prompt framing, and grader
fixed; vary ONLY the orchestration pattern. Score with RoadmapBench's own
hidden per-target tests via the fair-validated harness in
`benchmarks/roadmapbench/harness/` (oracle=1.0 / no-op<1.0 proven per task,
offline agent execution, uncredentialed grader dependency access, post-hoc
command+diff audit).

## Models (SOTA, single-model agents — NO fallback chains)

| Alias  | Model id                       | Price $/M in/out     | Role notes                                                                                                               |
| ------ | ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| sol    | `gpt-5.6-sol` (xhigh)          | 5 / 30               | frontier OpenAI; baseline + plan/review                                                                                  |
| luna   | `gpt-5.6-luna` (medium)        | 1 / 6                | cheap+fast implementer/researcher                                                                                        |
| fable  | `claude-fable-5`               | 10 / 50              | frontier Anthropic; panel reviewer                                                                                       |
| gemini | `gemini-3.1-pro-preview`       | (add to price table) | panel reviewer (kimi stand-in)                                                                                           |
| kimi   | `kimi-for-coding` (K3 lineage) | (add to price table) | **blocked**: both local kimi creds are dead (`_authentication_error`); joins the panel the moment `kimi login` is re-run |

Fallback chains are deliberately disabled inside benchmark runs: a run labeled
"sol" must never silently switch to another model — a quota block should park
the run (`waiting-quota`), which we detect and treat as a poisoned sample
(re-run after reset) rather than a silent identity change.

## Round 1 patterns

Shared across ALL patterns: identical ENV block (docker-exec toolchain access,
benchmark-integrity rules), identical roadmap instruction embedding, identical
isolated workspace prep. Only the node graph differs.

| id                         | Graph                                                                                                                       | Hypothesis                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `P0-sol-solo`              | sol does everything (single task, 150m)                                                                                     | quality/speed baseline ("/codex with the goal")                    |
| `P1-luna-solo`             | luna does everything (single task, 150m)                                                                                    | cost floor anchor                                                  |
| `P2-plan-impl-review`      | sol plan (75m) → luna implement (75m) → sol review+fix (75m)                                                                | role-split: frontier bookends, cheap middle                        |
| `C1-sol-sol-sol`           | sol plan (75m) → fresh sol implement (75m) → fresh sol review+fix (75m)                                                     | matched control isolating the Luna substitution                    |
| `C2-fable-fable-fable`     | fable plan (75m) → fresh fable implement (75m) → fresh fable review+fix (75m)                                               | cross-family matched control isolating the Luna substitution       |
| `C3-sol-terra-sol`         | sol plan (75m) → terra implement (75m) → fresh sol review+fix (75m)                                                         | intermediate capability tier                                       |
| `C4-sol-work-sol-review`   | one sol plans+implements (150m) → fresh sol review+fix (75m)                                                                | isolates the plan/implementation context break                     |
| `C5-sol-work-fable-review` | one sol plans+implements (150m) → fable review+fix (75m)                                                                    | reviewer-family control                                            |
| `P3-research-first`        | luna research (30m) → sol plan (60m) → luna implement (75m) → sol review+fix (75m)                                          | cheap recon compresses sol planning cost/time                      |
| `P4-panel-review`          | sol plan (75m) → luna implement (75m) → parallel findings-only panel: sol + fable + gemini (45m each) → luna fix pass (60m) | model-diverse review catches more defects than single-model review |

## Confirmatory matched controls

After Round 1 found `plan-impl-review` below `solo-sol`, a matched control was
added: `fable-plan-impl-review` uses fable for both the 75-minute planning and
75-minute review-and-fix stages while retaining luna as the 75-minute
implementer. Task, workspace, prompts, budgets, and hidden-test scorer remain
fixed. This isolates whether the result is specific to the sol/luna model
family pairing or general to delegating implementation away from the reviewer.
Design review before any confirmatory model cell identified a second confound:
`plan-impl-review` versus `solo-sol` changes both the implementer and the entire
execution graph. The confirmatory study therefore includes `sol-sol-sol` and
`fable-fable-fable`. Within each teacher family, the all-teacher and Luna-middle
pipelines use identical graphs, prompts, stage budgets, and fresh sessions; only
the implementation model differs. Solo Sol and solo Fable remain useful
operational baselines, but not causal controls for student replacement.

The four original tasks are a pilot. The confirmatory study is frozen in
`PERSUASION_GAP_PREREGISTRATION.md`: 30 new RoadmapBench tasks, six per language,
ten paired conditions, balanced execution order, and an implementation
checkpoint that measures the teacher review delta directly.

Panel reviewers are READ-ONLY (findings, no edits) — three concurrent editors
would trample one workspace; a single luna fixer applies the merged findings.
The panel runs in parallel across three different providers (max-concurrency 3
for P4 only), so no provider rate-limits another. Everything else runs
max-concurrency 1.

Round 2+ (data-driven, after Round 1 reads): candidates include panel-plan,
fable as implementer, best-of-2 luna implementations judged by sol, terra
mid-tier substitutions, kimi in the panel (post re-auth), a hard-difficulty
task (`opt-4.5.0-roadmap`, proven grader) for difficulty scaling.

## Round 1 tasks (stratified: 4 languages, all medium)

| Slug                 | Project | Language   | Note                                                                                                                                                                                                                                             |
| -------------------- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vbt-1.2.0-roadmap`  | Valibot | TypeScript | grader previously proven (ref: 0.714 by old opus/codex-5.5 pipeline)                                                                                                                                                                             |
| `opt-4.4.0-roadmap`  | Optuna  | Python     | family proven (opt-4.5.0 scored 1.000)                                                                                                                                                                                                           |
| `fbr-2.42.0-roadmap` | Fiber   | Go         | new family                                                                                                                                                                                                                                       |
| `rat-0.21.0-roadmap` | Ratatui | Rust       | new family. **Swap recorded**: the planned `rat-0.24.0` failed fair-validation (its oracle patch does not compile in the official image — rustc E0282 — so the grader can never reach 1.0); `rat-0.21.0` validated clean (oracle=1.0, no-op=0.0) |

The original pilot used 4 tasks × 5 patterns = 20 runs, ONE AT A TIME. Execution order: task-major
(all 5 patterns on task A, then task B …) so cross-pattern comparisons land
early. 1 attempt per cell in Round 1; replicates for frontier leaders in
Round 2.

## Metrics (per run)

- **quality**: `reward` ∈ [0,1] from the official hidden-test grader
  (partial credit = Completion Score semantics); `resolved` = reward==1.0.
- **speed**: `wall_s` = RunStarted→RunFinished minus `quota_stall_s`
  (time parked in waiting-quota); per-stage durations from node events.
- **cost**: API-equivalent USD = Σ `estimateCostUsd` over the run's
  `TokenUsageReported` events (per-model token breakdown recorded too).
  Subscription billing makes marginal cost lower; API-equivalent is the
  comparable, reproducible number.
- **integrity**: `tainted` (audit_run.py command+diff audit), retry/attempt
  counts, `quota_poisoned` flag (any waiting-quota or provider-429 stall →
  the cell is re-run once after the window resets; both samples recorded,
  only the clean one aggregated).

## Rate-limit hygiene (why one at a time)

1. No measured benchmark run starts while another workflow or provider client
   is active. Launch also requires three clean 10-second host samples (CPU idle
   ≥75%, disk ≤5 MB/s); failure to obtain that window within 30 minutes aborts.
2. Fleet gate before every launch: `smithers usage` codex weekly < 85%,
   else park until reset (5h claude windows are per-rolling; codex is weekly).
3. Detached engine runs (`smithers up -d`), never gateway-RPC (gateway
   restarts must not kill runs).
4. Docker hygiene between tasks: containers are removed after each run; a
   task's image is kept until its final condition finishes, then pruned.

## Aggregation

Per pattern: mean reward, mean cost, mean wall_s across tasks (+ per-task
table; n=4 means no error bars — report ranges honestly, not CIs). Primary
deliverables: cost-vs-quality and speed-vs-quality frontier plots with the
diminishing-returns knee identified, plus a per-pattern per-task matrix.
Output: `benchmarks/orchbench/RESULTS.md` + `results.jsonl` + artifact chart.

## Driver

`benchmarks/orchbench/driver.sh` — idempotent sequencer (skips cells with a
clean result; resumes in-flight run IDs). Each cell: verify its immutable
fairness receipt → prepare a fresh workspace from the pinned image → launch the
working-tree workflow → wait for terminal state → collect reward, checkpoint,
audit, per-stage identity, usage/cost, and timings. Launch, collection, quota,
and retry failures remain explicit; the completion sentinel is written only
when every required cell is clean. The exact confirmatory entrypoint is
`benchmarks/orchbench/run_persuasion_gap_confirm.sh`; it accepts no design
options and verifies the frozen 30-task artifact before running 300 cells. The
workflow's live UI remains `.smithers/ui/orchbench.tsx`.
