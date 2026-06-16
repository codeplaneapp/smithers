# Agent-Fluency Evals — Progress & Plan

> Durable backbone for this multi-session build. Update the checkboxes and counts as
> waves land. If you are a future session continuing this work, **read this file first**,
> then `README.md`, then `COVERAGE.md`.

## North star

Weak models (Haiku / Sonnet / Gemini / Kimi), given only Smithers' shipped docs + skills
+ CLI, should **one-shot** real Smithers tasks. Each eval = a Smithers workflow whose
candidate Task self-reports `oneShot` + `friction`; an independent verify step sets
`passed`; scorers grade quality. Failures and friction → a prioritized list of docs/APIs
to fix. Target: up to ~1000 evals, built wave by wave, every wave verified (renders +
dry-runs) before moving on.

## Phase status

- [x] P0 — Recon: understand runtime, CLI, `smithers eval`, scorers, agents, examples
- [x] P0 — Branch `evals/agent-fluency-suite` + scaffold (`README.md`, `PROGRESS.md`) + draft PR #294
- [x] P1 — Coverage map: 14-way agent sweep → `COVERAGE.md` (380 features, 416 tasks, 28 UNDOCUMENTED).
      Raw in `_inventory/coverage-*.json` + `task-bank.jsonl`. ⚠️ `docs-skills-surface` slice failed — backfill.
- [~] P1 — Real-usage mining: agent scanning Claude Code + Codex sessions (running in background)
- [x] P2 — Framework: `agents.ts`, `lib/{report-schema,model-matrix,scorers,verify,paths,eval-kit}.ts`, `tsconfig.json` (typecheck clean)
- [x] P2 — One suite end-to-end: `knowledge-cli` renders (`graph`), plans (`--dry-run`), and **passed a LIVE sonnet case** (candidate→verify→verdict→assert, 1/1, 32s)
- [x] P2 — Harness: `harness/{run-suite,run-all,scorecard,generate-cases}.ts` (reports under .report/, gitignored)
- [x] P2 — Case generator: task-bank + curated → 19 suites, **898 cases**, model fan-out + verify mapping
- [x] P2 — `new-eval.tsx` issue→eval generator (renders; drafts task → appends curated → regenerates)
- [x] P2 — Live-proved both deterministic verify paths: knowledge `equals` (sonnet PASS) + authoring `graph` (sonnet PASS, surfaced 4 real doc-friction notes)
- [x] P2 — Real-usage mining folded in → 37-case `real-usage` suite (edit-then-resume, Worktree cwd, waiting-event, JSON output, …)
- [ ] P3 — Waves: broaden live baseline runs across models; build fixture wave (84 deferred ops/db-query tasks)
- [ ] P3 — Backfill docs gaps the evals surface (fix docs in `docs/`, regen bundles)
- [ ] P4 — Cross-model baseline scorecard
- [ ] P5 — Codex review of the whole PR; address findings

### Proven facts (for future sessions)
- Eval run output = `{ <schemaName>: [rows] }`; assertions key on `outputContains: { verdict: [{ passed: true }] }`.
- Static/agentless verify = a `<Task output={...}>{ async () => verdict }</Task>` (compute child). Zero model spend.
- Claude Code engine has NO native structured output → prompt-injection JSON. `schemaAdherenceScorer` guards this.
- `llmJudge` real API = `{ id, name, description, judge, instructions, promptTemplate }` (NOT `{model,prompt}` — docs bug).
- Scorer `sampling` real shape = `{ type: "ratio", rate }` (NOT `{ kind, ratio }` — docs bug). Both in skills/.
- Eval runs isolated to `.smithers/state/evals.db` (gitignored).

## Wave plan (feature areas → suites)

Ordered cheap→expensive. Counts are *target cases* (model fan-out multiplies these).
Tier = which model tier the candidate runs on.

| Wave | Suite (area)            | Tier  | Verify           | Covers |
| ---- | ----------------------- | ----- | ---------------- | ------ |
| 1    | `knowledge-cli`         | weak  | deterministic    | "which CLI verb does X" across the whole verb catalog |
| 1    | `knowledge-components`  | weak  | deterministic    | "which JSX component for Y" across all ~30 user-facing components |
| 1    | `knowledge-concepts`    | weak  | judge            | mental-model questions (durability, frames, when-to-use) |
| 2    | `authoring-workflows`   | weak  | graph-renders    | write a workflow: sequence/parallel/branch/loop/ralph, schemas, deps |
| 2    | `authoring-approvals`   | weak  | graph-renders    | Approval / HumanTask / Signal / WaitForEvent / Timer |
| 2    | `authoring-scorers`     | weak  | typecheck+contains | attach scorers, write llmJudge, eval JSONL cases |
| 2    | `authoring-components`  | weak  | graph-renders    | use ReviewLoop/Optimizer/Panel/Debate/Supervisor/Saga/Kanban/… |
| 3    | `ops-runs`              | weak  | fixture DB       | ps/inspect/logs/cancel/approve/deny/resume/down |
| 3    | `ops-db-queries`        | weak  | fixture DB       | answer questions by querying the run SQLite (events/outputs/scores) |
| 3    | `ops-observability`     | weak  | fixture+judge    | scores/events/timeline/node/output/why/usage + OTEL stack |
| 3    | `ops-time-travel`       | weak  | fixture DB       | snapshots/fork/replay/rewind/restore/revert/timetravel/retry-task |
| 4    | `agents-models`         | weak  | typecheck        | agents.ts pools, fallback chains, per-task model choice |
| 4    | `integrations-mcp`      | weak  | judge/contains   | mcp add, skills add, cron, alerts, human inbox, hijack |
| 4    | `openapi-tools`         | weak  | typecheck        | generate AI SDK tools from OpenAPI; built-in tools + --root containment |
| 4    | `memory`                | weak  | fixture+contains | memory={{recall,save}}, `smithers memory`, namespaces |
| 4    | `sandboxes-worktrees`   | weak  | graph-renders    | Worktree / Sandbox / MergeQueue / Subflow / SuperSmithers |
| 5    | `serving-gateway-ui`    | weak  | typecheck        | up --serve, gateway HTTP/SSE, custom workflow UI (react/vanilla) |
| 5    | `effect-api`            | weak  | typecheck        | lower-level Smithers.workflow().step() Effect surface |
| 6    | `build-complex`         | sota  | graph+judge      | multi-feature end-to-end workflows (the only SOTA-tier suite) |
| 6    | `real-usage`            | mixed | per-case         | cases mined from actual Claude Code / Codex Smithers sessions |

## Counts

| Metric | Value |
| ------ | ----- |
| Suites scaffolded | 19 |
| Cases written | 898 (+84 deferred to fixture wave) |
| Cases dry-run verified | 898 (all suites plan clean) |
| Suites smoke-run on a real model | 2 (knowledge-cli, authoring-workflows; sonnet PASS) |
| Coverage-map features / tasks | 380 / 416 |

## Decisions / invariants

- Assertions gate on the **verifier's** `passed`, never the candidate's self-reported
  `oneShot`. Self-report is signal, not ground truth.
- Deterministic verify wherever feasible (no model spend in the gate). Judge verify only
  for genuinely open-ended correctness, on a SOTA model.
- Every case carries `metadata: { area, feature, tier, source }` so the scorecard can
  slice one-shot rate by feature and trace each case to its origin.
- Keep CI green: `evals/` is not a workspace; it ships its own `tsconfig.json` and a
  `typecheck:evals` script. Never let new files trip `check:docs` / `check:llms` /
  `check:deps`.
- Improving Smithers is the goal: when a wave exposes a real docs gap, fix the doc in
  `docs/` (and regen bundles) as part of the same effort — the eval is the evidence.

## Open questions / TODO parking lot

- Confirm which model API keys are available in this environment for smoke runs.
- Decide whether to register `evals/` suites in the seeded pack / starters.
- Wire `typecheck:evals` into CI once the suite stabilizes.
