# Workflow estimation

A cheap model, run as an opt-in step at the start of a workflow, forecasts how
many **tokens** the run will spend and how much it will **cost**, and from that
a **duration** the UIs refine in real time. The forecast is scored against the
run's actuals so the numbers get honest over time.

## Why tokens, not seconds

A model cannot know how fast it will be pushed — throughput (tokens/second)
depends on the provider's load, the account's rate limits, and how many agents
run in parallel. So the estimator predicts the one thing that is a property of
the *work*: **tokens** (and, via the price table, **dollars**). Wall-clock is
*derived*: `minutes = remainingTokens / tokensPerSecond`, where
`tokensPerSecond` starts from a per-model default and is corrected live from the
`TokenUsageReported` events and attempt wall-clock the run is already emitting.
The model never guesses a rate; the UI measures it.

## Decisions (locked)

- **Opt-in component, not engine-native.** Estimation happens only when a
  workflow includes `<Estimate>`. No per-run overhead is imposed on workflows
  that do not adopt it. (Rejected: automatic estimation on every run start.)
- **Full fan-out.** Core contract + all interactive surfaces + `../multi` UI +
  the main init-pack workflows + docs + an eval suite to tune the numbers.
- **Non-blocking.** `<Estimate>` runs in parallel with the real work; the run
  never waits on it. The forecast lands a moment after kickoff.

## The estimate shape

Reuse the existing `Estimate` envelope — do not invent a new one.

- `packages/gateway-react/src/delegation/types.ts` — `Estimate = { tokens, costUsd, minutes }`
- `packages/scorers/src/DelegationEstimate.ts` — `DelegationEstimate` (scored)
- `packages/components/src/components/delegation/delegationSchemas.ts` — `estimateSchema`

The component's task outputs a richer **`WorkflowEstimate`** that rolls up to
that envelope:

```ts
WorkflowEstimate = {
  totalTokens: number;         // sum over perTask, iterations folded in
  costUsd: number;             // totalTokens priced via modelPrices()
  // minutes is DERIVED downstream, not authored here
  perTask: Array<{
    nodeId: string;
    tokens: number;            // per single execution
    iterations: number;        // expected loop/retry count (>=1)
  }>;
  confidence: "low" | "medium" | "high";
  assumptions: string[];       // what the model assumed about scope/loops
}
```

`costUsd` is computed deterministically in a compute step from `perTask` +
`modelPrices()` (moved to a shared location, see below) — the model authors
token counts and iteration counts, code does the pricing.

## Components / files

### New

- `.smithers/components/Estimate.tsx` — the drop-in component. Props:
  `idPrefix?`, `input` (run input, scope signal), `workflowKey?` (defaults from
  ctx), `estimator?` (AgentLike[], defaults to a haiku-cheapest pool). Emits one
  `<Task agent={estimator} continueOnFail heartbeatTimeoutMs=...>` whose MDX
  prompt tells the model to read `.smithers/workflows/<key>.tsx`, skim the
  relevant repo files, reason about `input`, and output the per-task token +
  iteration breakdown. Then a compute task prices it (`modelPrices`) and folds
  it to the `Estimate` envelope. Exports `workflowEstimateSchema`.
- `.smithers/prompts/estimate.mdx` — the estimator prompt (forecast honestly,
  you are scored; count loop iterations explicitly; do not guess tokens/sec).
- `packages/engine/src/throughput.js` — `tokensPerSecond(events)` derived from
  `TokenUsageReported` + attempt wall-clock, with a per-model default seed
  (`DEFAULT_TOKENS_PER_SEC`). Pure, reused by every UI to derive minutes.
- A shared `modelPrices` — promote `apps/review/src/server/proxy/modelPrices.ts`
  to a shared module the estimator + UIs import (keep the review copy re-exporting
  it to avoid a dependency-boundary break). Land the table next to the SOTA
  registry so cost stays in one place.
- `evals/suites/estimation-accuracy/{eval.tsx,cases.jsonl}` — golden
  plan+actual pairs scored by `estimateAccuracyScorer` to tune the prompt/heuristics.
- Docs: `docs/guides/workflow-estimation.mdx` (Head First + Kernighan),
  `docs/reference/estimation.mdx` (Kernighan), nav in `docs/docs.json`, manifest
  entry in `scripts/generate-llms.ts`, regen `pnpm docs:llms`.

### The wire contract (engine → gateway → UI)

- **Event:** add `RunEstimated` to the event union
  (`packages/engine/src/index.d.ts:280`, `apps/observability/src/SmithersEvent.ts`).
  Payload: `{ runId, totalTokens, costUsd, perTask, confidence, model }`.
  Emitted by the engine when the estimate node finishes (detected by output
  matching `workflowEstimateSchema`); this fires only when `<Estimate>` is
  present, so the opt-in property holds. Emit + persist to `_smithers_events`.
- **Run row:** stash the latest estimate on the run so point queries expose it
  without replay — extend `serializeRunRow.ts` and the `getRun`/`listRuns`
  response schemas (`packages/gateway/src/rpc/index.ts`).
- **gateway-react:** surface the estimate off `useGatewayRun` (run row) and via
  `useGatewayRunEvents` (the `RunEstimated` frame); add a `useRunEstimate(runId)`
  helper that also computes the live-derived `etaMs` from `tokensPerSecond` +
  running actual tokens.

### Interactive surfaces (all named)

- **CLI `smithers up`:** print a `~N tokens · ~$X · ~Ym (est)` banner to stderr
  right before `runWorkflow` (`apps/cli/src/index.js` ~2511), and echo it in the
  detached `c.ok({...})` payload (~2217).
- **TUI:** add `estimate` to `RunHeaderData` (`packages/tui/src/headerUtils.ts`)
  and render it next to elapsed in `RunHeaderView` (`Header.tsx`).
- **MCP `run_workflow`:** add `estimate` to `runWorkflowDataSchema`
  (`apps/cli/src/mcp/semantic-tools.js:299`).
- **Post-run report:** `runReport.js` shows estimate-vs-actual accuracy.

### `../multi` UI (separate repo — safe to edit in parallel)

- Parse a `run.estimate` frame in `src/sync/useGatewayRunTree.ts:statusFromRunEvent`;
  add estimate to `GatewayRunTreeState`.
- Toasts/notifications: set the estimate line in `src/gateway/startWorkflowRun.ts`
  `notify()`/`update()`; render in `src/notifications/Toasts.tsx` and the
  Notifications history row (`src/approvals/ApprovalsCanvas.tsx` `ToastHistoryRow`).
- Run views: add `etaLabel`/`tokenEstimate`/`costEstimate` to `RunSummary`
  (`src/runs/runsList.ts`), map in `RunsListBridge.toRunSummary`, render in
  `RunsCanvas.tsx` `RunRow` and `GatewayRunCard.tsx`.
- Live accuracy: in `GatewayRunInspector.tsx`, combine the stored estimate with
  `useElapsed` + running token totals to show an "on track / over by N%"
  indicator.

### Init-pack workflows that adopt `<Estimate>`

The prompt-driven, user-launched ones (first parallel step, `continueOnFail`):
`implement.tsx`, `plan.tsx`, `research-plan-implement.tsx`, `research.tsx`,
`review.tsx`, `open-code-review.tsx`, `ralph.tsx`, `hello.tsx` (as the documented
example), and `archive/fix-all-issues.tsx` (highest cost → highest value).

## Scoring (eval-driven)

Reuse `estimateAccuracyScorer` (`packages/scorers/src/estimateAccuracyScorer.js`):
symmetric ratio `min(pred,act)/max(pred,act)` per dimension, cost-weighted mean.
Attach it at run finalize comparing the emitted estimate to aggregated actuals
(tokens from `TokenUsageReported`, minutes from run wall-clock, cost priced).

**Tuning harness:** `evals/suites/estimation-accuracy/` — golden cases of small
workflows with known actual tokens/cost/minutes. Run the estimator, score with
`estimateAccuracyScorer`, watch the cost-weighted mean. Tune the prompt +
iteration heuristics + `DEFAULT_TOKENS_PER_SEC` until the aggregate clears a bar
(target ≥ 0.7 on the dev split to start).

## Constraints

- Shared jj tree: smithers-repo edits are serialized (no concurrent
  tree-mutating agents). `../multi` is a separate repo and can run in parallel.
- No mocks in e2e; the eval suite uses golden actuals captured from real runs.
- `check-docs`/`check-llms` gate: regenerate `pnpm docs:llms` after doc edits.
- Dependency boundaries: don't make `.smithers` or the engine import from
  `apps/review`; promote `modelPrices` to a shared package first.
