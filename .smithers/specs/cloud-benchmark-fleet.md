# Cloud Benchmark Fleet

Run every smithers benchmark in parallel in the cloud, round-robining across
~6 Claude subscriptions, so a full pass finishes in days instead of weeks.
Long-horizon tasks run through the zero-approval delegation workflow. Results
publish to a `benchmarks.smithers.sh` site, and a self-improving eval loop
raises the scores over time.

Status: design. Date: 2026-07-06. Owner: will.

## 1. Goal and the shape of the problem

The workload is two jobs with different binding limits, and they must be sized
separately.

- **Rollout half** (the agent solves each task). Bound by the 6 Claude
  subscriptions and Anthropic's per-account weekly Opus cap, not by compute.
  Network-bound, cheap CPU. This is the only half where "a distinct
  subscription per container" matters.
- **Scoring half** (hidden-test grading via `docker run` on 1-4 GB linux/amd64
  images). Bound by Docker image-pull throughput and native amd64, not by
  Claude. Embarrassingly parallel, no rate limit. This is the half the repo
  currently cannot scale: `benchmarks/swe-bench-pro/RESULTS.md` records a run
  blocked by local OrbStack image-pull limits.

Splitting the fleet along that seam is the core design decision.

## 2. The workload: benchmark inventory

Nine assets in three tiers. All are parallelizable across instances/shards.

| Benchmark | Path | Tasks | Runtime driver | Uses delegation shape | Model matrix today |
|---|---|---|---|---|---|
| SWE-Bench Pro | `benchmarks/swe-bench-pro` | 731 | agent turns + amd64 docker score; image-pull is the bottleneck | yes (`runViaGateway.js`, one run/instance) | implement GPT-5.5, review Fable-5 |
| RoadmapBench | `benchmarks/roadmapbench` | 115 | 4-stage rollout over ~3,700 LOC + emulated docker grade; hours/task | yes (detached run/task) | plan/impl/final Opus 4.8, review Codex 5.5 |
| Claw-Eval-Live | `benchmarks/claw-eval-live` | 105 | multi-turn tool loop; hours/batch at 3 workers | no (OpenAI-compat gateway, `--parallel N`) | gather GPT-5.5, synth Fable-5, judge Gemini |
| SWE-EVO | `examples/swe-evo` | 48 | implement + refine + emulated pytest; 20-60 min/instance | yes (`run.ts` gateway, `run-suite.ts` supervisor) | implement Opus 4.8, refine Codex 5.5 |
| defending-code | `examples/defending-code` | 1 | ~6 min/run, single toy C target | no | Sonnet (any Claude), no external |
| Agent-Fluency Evals | `evals/` | ~6,289 cases / 27 suites | mostly deterministic-verify (seconds); judge/build spend a model | should move to delegation for cloud scale | per-case model incl. haiku/sonnet/opus |
| feature-eval-factory | `evals/feature-eval-factory.tsx` | meta | authoring fan-out + optimize loop; very long | yes (fan-out + nested Loop) | authors Codex/Antigravity/Opus |
| Seeded-workflow evals | `.smithers/evals` | 8 suites | seeded workflow end-to-end/case; tens of min | yes | chains lead with Fable-5 + Codex |

### 2.1 The model-matrix constraint per benchmark

Implementation is Claude and only Claude (Opus 4.8 / Sonnet 5), never Codex/GPT.
Review is a **panel** and Codex is welcome there (review only); pair it with Opus
for cross-family disagreement (`buildReviewPanel` + `review-panel.tsx`). No Fable-5
anywhere (it sits above Opus). Concretely: SWE-Bench Pro's implementer moves off
gpt-5.5 to Claude; RoadmapBench and SWE-EVO already implement with Opus; each
benchmark's single reviewer becomes a Codex+Opus panel. Three benchmarks still
cannot be run "faithfully" as their authors intend on this matrix.

- **Clean swaps (env var or one flag):** RoadmapBench review Codex 5.5 to
  Opus/Sonnet (edit `roadmapbench.tsx` lines 164-165); SWE-Bench Pro
  `--implementer`/`--reviewer` or `SWEBP_*_MODEL` to Opus/Sonnet; SWE-EVO
  `SWEEVO_CODEX_MODEL` refine to Opus. defending-code and the haiku/sonnet/opus
  subset of the fluency evals already run as-is.
- **Cannot be run faithfully Claude-only:**
  - **Claw-Eval-Live.** Its gather leg is native OpenAI tool-calls, and its
    neutral judge (`gemini-2.5-flash-lite`) is the benchmark's own grader,
    required for correct scoring. A Claude-only variant is a different
    measurement. Either accept an asterisked "Claude-synth" variant, or keep an
    `OPENAI_API_KEY`/`GEMINI_API_KEY` on the scoring/judge path only (no
    subscription involved) and document it.
  - **Seeded-workflow evals + feature-eval-factory.** They hardcode/lead with
    Fable-5 (stronger than Opus) and GPT-5.5. On a Claude-only fleet they
    degrade to Opus or fail preflight. Exclude from the "Claude Opus-and-weaker"
    board, or re-tier `.smithers/agents.ts` to lead with Opus and label them a
    distinct configuration.

The board must carry `n`, subset, model, and scaffold on every row so a
Claude-only variant can never imply a full-benchmark claim.

## 3. Architecture: a split fleet on one shared store

```
                     ┌──────────────────────────────┐
                     │  Postgres (shared run store)  │  reuse examples/kubernetes/k8s/postgres.yaml
                     │  durable, crash-safe, one DB  │
                     └──────────────┬───────────────┘
                                    │
     ┌──────────────────────────────┼──────────────────────────────┐
┌───────────────┐        ┌────────────────────────┐      ┌────────────────────────┐
│ Orchestrator  │        │  ROLLOUT FLEET (Fly)    │      │  SCORING POOL (amd64)   │
│  gateway pod  │        │  6 Machines, 1 per sub  │      │  2 Hetzner AX52         │
│ smithers serve│        │  distinct OAuth token   │      │  native amd64, root     │
│  --gateway    │        │  network-bound, cheap   │      │  Docker, warm cache     │
│ 2 vCPU / 4 GB │        │  2-4 vCPU / 8 GB each   │      │  8-16 vCPU / 32-64 GB   │
└───────────────┘        └────────────────────────┘      └───────────┬────────────┘
                                                                      │
                                                          ┌────────────────────────┐
                                                          │ Object store (R2/S3)    │
                                                          │ reports + patches       │
                                                          └────────────────────────┘
```

- **1 orchestrator/gateway.** The `orchestrator` target of
  `examples/kubernetes/Dockerfile` (`smithers serve --gateway`). Hosts runs
  in-process, durable in Postgres, resumable if it dies. Singleton control
  plane per workspace (`packages/server/src/gateway.js`, state-dir discovery).
- **6 rollout Machines**, one per subscription, 2-4 vCPU / 8 GB. `claude` is
  network-bound so shared-cpu is fine; 8 GB buys headroom for large real-repo
  checkouts. Each drives its assigned shard.
- **Scoring pool: 2 amd64 Docker workers** (Hetzner AX52 or equivalent). Native
  amd64 removes QEMU emulation, root Docker plus a registry pull-through cache
  on local NVMe removes the pull-limit blocker. Runs the existing hermetic
  scorers (`benchmarks/swe-bench-pro/src/scorePatch.js`,
  `examples/swe-evo/harness/score_instance.py`) as `smithers worker` jobs off a
  Postgres queue. No Claude auth here (the one exception is Claw-Eval-Live's
  Gemini judge, which needs a `GEMINI_API_KEY`).
- **Object storage** for report/artifact export. Fills the current gap where
  reports only land in local `config.workDir/reports`.

Externalize the run DB to Postgres (`--backend postgres`, recorded in
`.smithers/migrated.json`) so orchestrator, rollout Machines, and scoring
workers share one crash-safe store. The benchmark harnesses default to
per-invocation `bun:sqlite` (`SWEBP_DB_PATH`), so either point them at Postgres
or use the `runViaGateway.js` fresh-gateway-DB-per-instance isolation recipe.

## 4. Cloud provider decision

**Best for the rollout fleet: Fly.io Machines.**

- **Per-container credential isolation is best-in-class.** The Machines API
  `create`/`update` takes a per-Machine `env` map, so each of the 6 Machines
  boots with a different `CLAUDE_CODE_OAUTH_TOKEN`. Zero smithers code change.
  Do not use `fly secrets` (app/org-wide, shared); use the per-Machine `env`.
- **Multi-hour tolerance is excellent.** No serverless timeout, no idle-kill
  unless configured. A run that parks on `waiting-quota` and wakes hours later
  is fine.
- **Cheapest credible managed option.** Rollouts are API-bound, so shared-cpu
  2 vCPU/4 GB at ~$0.016/hr works; 6 Machines for a ~96 h pass is ~$10.
- **Simple REST fan-out.** One app holds all 6 Machines. Pace creation (burst
  ~3 req/s) and file a support ticket to lift the new-org anti-abuse scaling cap
  before the burst.
- Wrinkle: Fly Machines do not expose a host Docker daemon, so `docker run`
  scoring does not belong on rollout Machines. That is why scoring is a separate
  amd64 pool.

**Runner-up (one platform for both halves): Northflank.** Native Jobs primitive
(fan out one job per subscription), managed Postgres addon, persistent volumes,
and privileged Docker jobs so scoring lives on the same platform. Per-object
(not per-replica) creds and more assembly than Fly.

**Scoring pool: Hetzner dedicated + Docker.** Cheapest absolute (~EUR45/mo/box),
native amd64, root Docker, local NVMe image cache, SQLite "just works." Ideal
for the embarrassingly-parallel scoring half; a poor primary because you DIY
orchestration.

Why the others lose: Modal (best ergonomics, ~3x Fly, 24 h hard cap, ephemeral
fs); AWS Batch (strong if already on AWS, ECR pull-through cache fixes scoring,
but IAM/VPC boilerplate and a default 6-vCPU Fargate quota to raise); Cloud Run
Jobs, Freestyle, RunPod, Railway, Depot are weaker fits for hours-long,
per-container-secret, Docker-heavy work.

## 5. Subscription round-robin

**Ratio: 1 container : 1 subscription. Six subs, six rollout containers. Never
stack two containers on one sub** (they race each other into the same pooled
quota and the server-side burst limiter, yielding more 429s, not more
throughput; GitHub anthropics/claude-code#53922).

**Injection, zero code change.** Mint one token per subscription with
`claude setup-token` on a logged-in host. Each Fly Machine's per-Machine `env`
sets one distinct `CLAUDE_CODE_OAUTH_TOKEN`, and no `ANTHROPIC_API_KEY` /
`ANTHROPIC_BASE_URL`. `ClaudeCodeAgent` already leaves that token intact and
strips `ANTHROPIC_API_KEY` so `claude` runs on the subscription. This is exactly
what `apps/review/action` does for one subscription
(`resolveInferenceEnv.ts` "claude-subscription" mode); round-robin is just
choosing which secret each Machine gets.

**"Round-robin" is shard distribution across the 6 fixed containers, not token
rotation.** Because each container *is* a subscription, the orchestrator assigns
task shards to containers. Make it **least-used-weighted**: poll `smithers usage`
(fans `GET /api/oauth/usage` over accounts, normalizes `five_hour`,
`seven_day`, `seven_day_opus`) and steer new tasks toward the container whose
sub has the most 5h + weekly-Opus headroom; skip any sub near 100% until reset.
The existing `waiting-quota` auto-resume already parks a run that trips a window
and wakes it at the parsed reset time (engine `markRunWaiting` + gateway
`processDueTimers`), so a saturated container self-heals.

**Within a container:** cap ~3-5 concurrent Opus threads (realistically 1-2
heavy rollouts plus a Sonnet fan-out) before local thread-limit and supervisor
walls bite. **Stagger container and session starts with backoff + jitter.** Do
not cold-start all 6 subs at once right after a 5-hour reset, or the burst
limiter ("Server is temporarily limiting requests (not your usage limit)")
fails the last several.

**Alternate (not used here): several subs inside one container.** You cannot mix
two `CLAUDE_CODE_OAUTH_TOKEN`s in one process. Materialize N config dirs each
with its own `.credentials.json`, register with `smithers agents add
--skip-login`/`--force`, and pass a distinct `configDir` per `ClaudeCodeAgent`.

### 5.1 Durability across the 5-hour rate limit (native)

A subscription running many agents will hit its 5-hour window; the fleet must
survive that and resume automatically when the window resets, with no manual
restart. Smithers already does this and the fleet uses it end to end:

- **Park.** When an agent trips the limit, `ClaudeCodeAgent` classifies the
  banner (even when Claude prints it as ordinary result text with exit 0) and
  the engine marks the run `waiting-quota` with the parsed reset time on
  `run.errorJson` (`engine.markRunWaiting`).
- **Auto-resume.** The gateway daemon's `processDueTimers` sweep
  (`packages/server/src/gateway.js`) lists `waiting-quota` runs, parses the
  reset, and resumes each at its boundary via `resumeRunIfNeeded`. A run with no
  reset (credit exhaustion, not the 5-hour window) is deliberately left for a
  human, because waking it would loop the same wall.
- **Keep the daemon alive.** The one requirement the fleet must satisfy: the
  container must stay up so that sweep keeps firing. The rollout worker runs
  `smithers serve --gateway --supervise` (auto-resume sweep plus the stale-run
  supervisor) and blocks until every shard task is terminal. Fly Machines have
  no timeout, so a multi-hour park costs only idle CPU. The worker also keeps a
  backstop (`shouldResumeQuota`) that resumes a run whose window has already
  passed if the sweep was briefly down.

Because every run is a durable, DB-backed detached run (Postgres in the fleet),
a killed container or daemon resumes from durable state rather than restarting.
Net effect: hit the 5-hour limit, the whole shard freezes, and ~5 hours later it
thaws and continues on its own.

## 6. The delegation workflow for long-horizon tasks

`.smithers/workflows/delegation-chain.tsx` (`DelegationChain`) is the recursive,
multi-tier, zero-approval engine. Recursion is in-run task fan-out (level-by-
level `dc*` output rows), bounded by `maxDepth` (default 3), `maxConcurrency`
(default 4), `maxDeriskRounds`, and `maxAttempts`. Reports bubble via the
nearest parent only. It self-plans, self-derisks, self-gates (commit-range
reviews, shell checks, previews), enforces `budgetUsd`/`budgetMinutes`, and
emits five delegation scorers.

**Zero approvals is the default.** Leave `approvalPolicy` unset. Enforced at two
layers: the prompt layer tells every delegating agent that approval gates are
disabled, and `delegationState.splitGates` drops any approval gate when
`approvalPolicy` is falsy, so `DelegationExecution` never mounts an `<Approval>`.

**Gap to close for unattended benchmark runs.** The seeded chain still mounts
`GoalRefinement`, which ends in a mandatory `dc:goal:approve` HumanTask, and an
end-of-run satisfaction poll. "Zero approvals" means zero *execution* approvals,
not fully headless. For a benchmark rollout: set `maxQuestions:0` and
`poll:false`, and either auto-resolve the goal-approval HumanTask, or embed
`<DelegationChain prompt=...>` directly (passing `prompt` to
`DelegationPlanning` bypasses goal approval). Track this as a smithers fix (a
`headless: true` input that skips goal approval and the poll).

Use it for the open-ended long-horizon tasks (RoadmapBench-style version
upgrades, SWE-EVO release transitions). The dedicated harnesses
(`roadmapbench.tsx`, `swe-evo`) stay as they are; they already ship the
detached-run-per-instance pattern.

## 7. Timing and cost for one full pass

**Workload:** the four external benchmarks total 999 tasks (731 + 115 + 105 +
48), plus defending-code (1) and the Claude subset of the fluency corpus
(thousands of mostly deterministic cases, a few hours, negligible Opus). Assume
~0.5 h average active rollout per external task, so ~500 agent-hours for one
pass.

**Binding number: the weekly Opus cap.** ~24-40 Opus-h/week per Max 20x, so
~144-240 Opus-h/week across 6 subs.

- **Pure-Opus:** 500 / ~192 ≈ 2.5-3.5 weeks, gated by weekly Opus lockouts.
- **Sonnet-heavy (recommended):** route ~80% to Sonnet, reserve Opus for the
  hardest ~100-150 tasks. Opus load ~50-75 h (fits inside one week); Sonnet load
  ~400-450 h against ~1,440-2,880 Sonnet-h/week. Wall-clock becomes
  concurrency-bound: ~1,000 tasks x 0.5 h / ~18 avg concurrency ≈ 28 agent-hours,
  which with staggering, retries, and burst backoff lands at **~3-5 days**.
- **Scoring** overlaps: ~1,000 tasks x ~5-15 min / ~24 concurrent ≈ ~7
  compute-hours, plus a one-time ~12-24 h image-pull warmup (SWE-Bench Pro alone
  is ~950 GB of images), cached after first pull. Off the critical path after
  warmup.

**Verdict: ~3-5 days per full Sonnet-heavy pass; ~3 weeks if pure Opus.**

**Cost per pass:** Fly rollout ~$10 (shared) to $60 (performance); Hetzner
scoring ~EUR12 prorated (or ~EUR90 to keep boxes and the image cache warm all
month); Postgres ~$3-4 prorated or free self-hosted; object storage ~$1-10.
**Infra total ~$30-120 per pass.** The dominant, fixed cost is 6 x Max 20x @
$200/mo = $1,200/mo; infra is rounding error.

**Compliant-alternative cost (API keys), for contrast:** the same ~500
rollout-hours on the Anthropic API is roughly $3k-15k per pass (Opus-heavy
toward five figures, Sonnet-heavy with prompt caching toward low four figures).
That ~50-100x gap is why the subscription route is tempting and why Anthropic
restricts it.

## 8. Benchmark results site

Ship a static-generated site first; add a live gateway leaderboard only once
runs stream in real time.

**Phase 1 (static, matches every existing `*.smithers.sh` precedent):**
1. `apps/benchmarks-site` serving `benchmarks.smithers.sh`, copied from
   `apps/ui-site` (`src/worker.ts` asset server, `alchemy.run.ts` Worker+Assets+
   custom domain, `wrangler.jsonc`). Deploy is `pnpm -C apps/benchmarks-site
   deploy` (Cloudflare Worker + Assets).
2. One canonical dataset `benchmarks/results.json`, shape borrowed from
   `examples/swe-evo/official-results.json`:
   `{ benchmarks: [{ id, dataset, models, headline, leaderboard: [{model,
   scaffold, metric, value, n, ci}], instances: [...] }] }`. Every row carries
   `n`, subset, and CI so no Claude-only variant implies a full claim.
3. A `make-site.ts` generator lifted from `examples/swe-evo/make-showcase.ts` +
   `report.ts` (inline dark/light CSS, stat-tile hero, rank-ordered table).
   Emit a self-contained, no-network, theme-aware `site/index.html`. Reuse
   `apps/cli/src/runReport.js` for optional per-instance detail pages. Commit
   both `results.json` and the generated HTML so the build is deterministic and
   CI-gateable (as `apps/ddd-site` bakes generated data into static HTML).

**Phase 2 (live leaderboard):** a singleton Smithers Gateway over shared
Postgres (`runViaGateway.js` pattern) plus a small gateway-react SPA using
`useGatewayRuns` / `useGatewayScores` / `useGatewayRunEvents`; the same
Cloudflare Worker proxies `/api/*` to it (same-origin proxy precedent in
`apps/review`). The static page stays the default and fallback.

## 9. Self-improving eval loops

Smithers already has most of the loop. What exists:

- **`smithers optimize` (GEPA), the keep-if-better primitive.** One round of
  baseline to LLM-proposed prompt patch to re-run to keep-if-better
  (`apps/cli/src/optimize-command.js:331`, `OPTIMIZATION_NO_IMPROVEMENT`). The
  winning artifact overlays prompts by nodeId at render
  (`SMITHERS_OPTIMIZATION_ARTIFACT` + `applyOptimizationArtifactToTasks`), so no
  source is edited.
- **`feature-eval-factory.tsx`, an iterate-until-target loop** that improves the
  root-cause docs. Missing a keep-if-better revert (a regressing docs edit is
  not rolled back).
- **Scorer system** (`packages/scorers`): `Scorer` contract, `llmJudge`,
  built-ins, `aggregateScores` / `weightedScore` / `delegationRunScore`,
  deterministic sampling, live scoring wired into the engine.
- **Durability** (snapshots, `fork` / `replay` / `rewind` / `restore`),
  `<Worktree>` and `smithers eval --root` isolation, headless delegation.

What to build (the delta):

1. **Iterated keep-best optimize.** Add `--iterations N` to `smithers optimize`:
   an outer hill-climb that feeds the current best artifact forward as the next
   baseline overlay, asks GEPA for the next patch conditioned on the latest
   failing cases, and adopts it only on strict improvement. Small change to
   `optimize-command.js`.
2. **A seeded `self-improve` system workflow** (`.smithers/workflows/self-improve.tsx`,
   `// smithers-system: true`), the main new piece. Improves any target (a
   prompt `.mdx`, a workflow `.tsx`, or an agent config in `agents.ts`), gated
   on a scorer objective. Per round: snapshot the target, run `smithers eval`
   for a baseline objective (passRate or a scorer mean via `aggregateScores`),
   a headless `propose` agent writes a candidate edit, re-run over the same
   cases, then a `decide` compute node keeps the edit only if `candidate >
   best + minDelta` and a holdout suite does not regress, else revert via
   `smithers restore` / `git checkout`. Loop convergence is computed in the
   workflow fn (feature-eval-factory pattern), not via `Optimizer.targetScore`.
   Runs detached (`smithers up self-improve.tsx -d`), optionally gating only the
   final commit-to-main behind one `<Approval>`.
3. **Add a keep-if-better guard** to feature-eval-factory Phase 2.
4. **Fix the Optimizer component:** `targetScore` is destructured-missing and
   never reaches the Loop host, so score-convergence never early-stops. Wire it
   through or document the workflow-fn pattern (a smithers fix per the standing
   directive).

Guardrails: prefer a scorer mean over raw passRate so trends improve before a
red case flips; keep a dev/holdout split; never weaken a benchmark to pass it.

## 10. Risks and mitigations

1. **ToS (highest severity).** Subscription OAuth is contractually scoped to the
   Claude Code CLI / Claude.ai and "ordinary, individual usage." A headless,
   multi-account cloud pool matches the 24/7-background / account-sharing
   pattern Anthropic penalizes, clarified Feb 20 2026, actively blocked since
   Jan 2026, agent subsidy ended ~June 15 2026, enforced without notice. The
   *cleanly compliant* path for cloud automation is API keys or Team/Enterprise
   seats. Six subs each owned by a genuinely separate individual is defensible;
   six consumer subs controlled by one entity as a shared automation pool is the
   gray-to-red zone. Mitigation if using subs anyway: strict 1 account : 1
   container, no pooling/reselling, short-lived rather than 24/7, and wire an
   API-key fallback (`ANTHROPIC_API_KEY` on `ClaudeCodeAgent`, or the metered
   proxy) so a mid-run enforcement does not strand the pass. **Decide this
   before scaling.**
2. **Burst limiter on simultaneous starts.** Stagger boots and session starts
   with backoff + jitter; never cold-start all 6 at once, especially right after
   a 5-hour reset. Smithers already classifies the banner and retries.
3. **Weekly Opus cap exhaustion mid-run.** Budget by weekly Opus hours, not
   instantaneous concurrency; Sonnet-heavy routing; monitor with `smithers
   usage`; lean on `waiting-quota` auto-resume.
4. **Credential refresh/expiry in a headless container.** `setup-token` tokens
   are long-lived but not eternal, and a fresh container has no interactive
   refresh. Track `expiresAt` and rotate proactively, or mount a full `configDir`
   (with `refreshToken`) via `CLAUDE_CONFIG_DIR` so the CLI self-refreshes; keep
   a re-mint runbook.
5. **Phantom failures.** Claude prints limit banners as ordinary result text
   with exit 0. Already handled (`classifyQuotaError` + `limitBannerText`,
   hardened main `96674f58` + `e5e3f77f`). "Out of usage credits" (no reset
   time) is deliberately parked for a human; monitor parked runs (`smithers ps`
   / `why`) and keep a top-up/re-login runbook.
6. **Docker scoring bottleneck (proven blocker).** Run scoring on native amd64
   with a registry pull-through cache and warm NVMe; pre-pull the image set once
   and keep the scoring boxes rented across passes.
7. **Shared-store and running-workflow hazards.** Externalize to Postgres; use
   fresh-gateway-DB-per-instance isolation; freeze workflow source during a pass
   (editing a running `.tsx` throws `RESUME_METADATA_MISMATCH`).
8. **Provider scaling caps.** File the Fly anti-abuse limit increase (and the AWS
   Fargate vCPU quota if AWS) before the burst.

## 11. Smithers gaps to fix at the source

Per the standing "improve smithers itself" directive, this effort surfaces
durable gaps worth fixing in-repo rather than working around:

- No first-class "run a benchmark in the cloud" command or hosted runner; the
  three harnesses are laptop scripts. Package a headless cloud job (a
  `system: true` fleet workflow) that fans instances across containers.
- The only native remote-exec sandbox backend (`codeplane`) is a stub; real
  remote execution needs provider glue today.
- No shared benchmark-results aggregator or reusable results-page generator;
  each suite hand-rolls JSON to MD/HTML. Extract one generator + one
  `benchmarks/results.json` schema (make it a `system: true` publish workflow).
- No object-storage export for reports/artifacts.
- `DelegationChain` has no headless mode (mandatory goal-approval + poll); add a
  `headless: true` input.
- `Optimizer.targetScore` never reaches the Loop host, so score-convergence does
  not early-stop.
- Benchmark harnesses default to per-invocation `bun:sqlite` with no
  shared-Postgres path.

## 12. Phased delivery

- **M0 Auth + one-box proof.** Mint 6 `setup-token`s. Run one benchmark
  (defending-code, then SWE-EVO dvc subset) in one Fly Machine with one
  subscription, Sonnet-heavy, no code change. Prove the model-matrix swaps and
  the headless delegation config.
- **M1 Shared store + scoring pool.** Stand up Postgres and 2 amd64 scoring
  boxes with a warm image cache. Move the SWE-Bench Pro image set once. Prove
  the rollout/scoring split on ~20 instances.
- **M2 Six-container fleet + least-used sharding.** All 6 Machines, per-Machine
  token, least-used-weighted shard assignment reading `smithers usage`, staggered
  starts. Full pass over the 999 external tasks.
- **M3 Results site.** `apps/benchmarks-site` + `benchmarks/results.json` +
  `make-site.ts`; publish `benchmarks.smithers.sh`.
- **M4 Self-improving loop.** `--iterations` on `smithers optimize`, then the
  `self-improve` system workflow; run it against the fluency board and one
  external benchmark's scaffold prompts.
