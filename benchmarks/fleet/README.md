# Benchmark Fleet

Run the Smithers benchmark suite in parallel in the cloud across ~6 Claude
subscriptions, so a full pass finishes in days instead of weeks. Design and
rationale: [`.smithers/specs/cloud-benchmark-fleet.md`](../../.smithers/specs/cloud-benchmark-fleet.md).

The fleet is split along its real bottleneck: the **rollout half** (the agent
solving each task) is bound by your subscriptions and the weekly Opus cap, and
the **scoring half** (`docker run` hidden-test grading on amd64 images) is bound
by image-pull throughput. They run on different machines.

```
Postgres (shared run store)
  ├── orchestrator: smithers serve --gateway
  ├── rollout fleet: 6 Fly Machines, 1 subscription each   ← this package
  └── scoring pool: 2 amd64 Docker boxes, warm image cache
```

## What's here

Pure, tested core:
- `planShards.ts` — distribute tasks across subscriptions, weighted by
  rate-limit headroom (`headroomScore.ts`). Even round-robin with no usage data;
  steers away from near-exhausted subs when usage is attached. Deterministic.
- `resolveSubscriptions.ts` — enumerate registered `claude-code` accounts from
  `~/.smithers/accounts.json`.

Claude-only delegation:
- `buildFleetTiers.ts` + `defaultFleetTierModels.ts` — the Opus-and-weaker tier
  map for `<DelegationChain>`: Opus plans and reviews, Opus delegates to Opus,
  and down to Sonnet to implement, Haiku on previews.
- `benchmark-delegation.tsx` — a headless, zero-approval delegation workflow for
  long-horizon benchmark tasks (`maxQuestions:0`, `poll:false`, no
  `approvalPolicy`).

Shard prep + self-improvement:
- `buildDelegationShardTasks.ts` + `benchmarkTasksFromInstances.ts` — turn
  prepared `BenchmarkInstance`s into per-instance delegation runs.
- `self-improve.tsx` — a durable keep-if-better eval loop: snapshot a target
  file, an Opus agent proposes one improvement, re-run the eval, keep only on a
  strict score gain (holdout-guarded), else revert. Run with
  `smithers up benchmarks/fleet/self-improve.tsx -d --input '{...}'`.

The results site lives at `benchmarks/site/` (generator + `benchmarks/results.json`).

Orchestration:
- `cli.ts` — `plan` dry-runs the shard assignment.
- `worker.ts` — the rollout-container entrypoint: runs a durable control plane,
  launches one shard, auto-approves the built-in goal gate, and supervises to
  completion across the 5-hour rate limit.
- `isTerminalStatus` / `shouldResumeQuota` / `parseFleetRuns` — the tested
  supervisor decision logic.
- `Dockerfile` — the rollout image.

## Durability across the 5-hour rate limit

This is native, and the fleet uses it. When a subscription hits its 5-hour
window, smithers parks each of that sub's runs as `waiting-quota` with the parsed
reset time (`engine.markRunWaiting`), and the gateway daemon's `processDueTimers`
sweep auto-resumes them at the boundary — no human, no restart. The worker runs
`smithers serve --gateway --supervise` (that sweep plus the stale-run supervisor)
and keeps the container alive until every task is terminal, so the parked runs
have a live daemon to wake into. Fly Machines have no timeout, so a multi-hour
wait costs only idle CPU.

`shouldResumeQuota` is a backstop the worker applies only if a run's window has
*already* passed (e.g. the sweep was briefly down); it mirrors the native rule
and never wakes a credit-exhaustion park (no reset time), which is left for a
human. Run DB lives in Postgres (`--backend postgres`) so a killed container's
runs resume from durable state.

## Round-robin across subscriptions

Strictly **1 container : 1 subscription** — stacking containers on one sub just
races the same pooled quota and the burst limiter. Each container gets a
distinct `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in its env and no
`ANTHROPIC_*`; `ClaudeCodeAgent` already routes that to subscription auth (zero
smithers code change, same as `apps/review/action`).

"Round-robin" is therefore **shard distribution** across the fixed containers,
not token rotation. Attach each sub's `usage` (from `smithers usage`) before
planning and `planShards` weights the split toward whichever sub has the most
5-hour + weekly-Opus headroom; smithers' `waiting-quota` auto-resume heals a
sub that trips a window mid-run.

## Log in your 6 subscriptions

```bash
cd benchmarks/fleet
bun cli.ts login --count 6     # one Claude Code /login per account, isolated config dir each
bun cli.ts tokens              # mint a portable CLAUDE_CODE_OAUTH_TOKEN per account (for Fly env)
```

`login` walks you through logging in to each subscription in its own
`~/.smithers/accounts/fleet-<i>` config dir (interactive, resumable — already
logged-in dirs are skipped) and records them in the fleet manifest that
`resolveSubscriptions` reads. For the cloud, either **mount each config dir** into
its container (`CLAUDE_CONFIG_DIR`, self-refreshing) or inject the
`CLAUDE_CODE_OAUTH_TOKEN` from `tokens` as that Machine's env (no `ANTHROPIC_*`).

## Try it

```bash
bun test                                             # the fleet logic (39 tests)
bun cli.ts plan --benchmark swe-bench-pro --tasks 60 --subs s1,s2,s3,s4,s5,s6
bun cli.ts prep --benchmark swe-evo --instances ./instances.json --subs s1,s2,s3 --out-dir ./shards
```

## Two shard paths

- **Harness path** (benchmarks that ship a per-instance workflow + dataset
  fetcher: SWE-Bench Pro, SWE-EVO, RoadmapBench). The fleet shards the instance
  ids and each container runs that benchmark's own harness for its subset via
  `benchmarkHarnessCommand`. Datasets are fetched by the benchmark's own script
  (`fetch-dataset.js`, `dataset/load.ts`, `launch_benchmark.sh`) — nothing is
  missing from the repo.
- **Delegation path** (open-ended tasks). `buildDelegationShardTasks` turns
  instances into `benchmark-delegation.tsx` runs.

## Model matrix (per the rules)

**Implementation is Claude, never Codex. Review is a panel; Codex is welcome as a
reviewer.** `buildReviewPanel` returns the Codex+Opus panel and `review-panel.tsx`
runs them in parallel and aggregates the verdict.

| Benchmark | Implement | Review |
|---|---|---|
| SWE-Bench Pro | `--implementer claude-sonnet-5` (was gpt-5.5) | Codex reviewer today; panel = harness edit |
| RoadmapBench | Opus (already Claude) | Codex reviewer (`ROADMAPBENCH_REVIEW_MODEL`); panel = harness edit |
| SWE-EVO | Opus (already Claude) | Codex refine reviewer |
| Claw-Eval-Live | cannot run faithfully Claude-only (native OpenAI gather leg + neutral Gemini judge) — asterisked variant |
| benchmark-delegation | Sonnet (Claude) | Opus (delegation-chain internal; single-model) |

To make each harness's review a true **panel**, replace its single review stage
with `review-panel.tsx` (Codex + Opus in parallel → aggregated decision).

## Not built yet (needs the cloud, not code)

- **amd64 scoring pool + object-storage export** — needs the cloud boxes.
- **Real run** — `fleet login` your 6 subscriptions, then a Fly account.
- **Per-benchmark id enumeration** for the harness path reads each benchmark's
  fetched dataset (run its fetch script first); `benchmarkHarnessCommand` already
  emits the Claude-only run command for a shard of ids.

## Two smithers edits to apply at the source (deferred — gate-checked files)

These improve smithers itself but touch shared, gate-checked packages, so they
are specified here rather than applied blind in a shared tree:

1. **`.smithers/workflows/roadmapbench.tsx`** hardcodes the review model to
   Codex 5.5 (`new CodexAgent({ model: "gpt-5.5" })`, ~L165). Make it env-
   overridable so the fleet can run Opus-only:
   `const reviewModel = process.env.ROADMAPBENCH_REVIEW_MODEL` → if it starts
   with `claude`, `new ClaudeCodeAgent({ ...common, model: reviewModel })`, else
   the current `CodexAgent`. Default unchanged. (SWE-Bench Pro / SWE-EVO already
   take `--implementer`/`--reviewer` / `SWEEVO_CODEX_MODEL` env overrides.)
2. **`DelegationChain` headless mode.** `GoalRefinement` always mounts a
   `:goal:approve` HumanTask, so `worker.ts` auto-approves it today. The clean
   fix is a `headless` prop on `DelegationSharedProps` that, in
   `GoalRefinement`, sets `maxQuestions:0` and replaces the step-5 HumanTask with
   an auto-approval compute Task writing `{ approved:true, refinedPrompt }` to
   `o.dcGoalApproval`. Then the fleet needs no auto-approve step.
