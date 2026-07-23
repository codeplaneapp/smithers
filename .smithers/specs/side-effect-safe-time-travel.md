# Side-effect-safe time travel

Time travel is the flagship: revert, rewind, fork, replay against durable
snapshots. Durability already survives crashes. What is missing is the third
leg: external side effects. Today `smithers revert`/`timetravel`/`rewind` will
happily rewind a run past a Slack message, a PR merge, or a deploy, leaving the
run's recorded state claiming the effect never happened while the outside world
disagrees. This spec makes every time-travel operation effect-aware: it errors
when it would cross a side effect, `--force` bypasses with a mandatory report,
and tools/tasks can register `revert` handlers so crossing becomes a clean
compensation instead of a lie. It also ships a large deterministic eval corpus
that verifies agents actually mark side-effecting steps.

## Definitions

**Side effect.** An externally observable mutation whose state lives outside
(a) the run's git/jj-tracked worktree and (b) the smithers DB. Examples:
HTTP mutations to third-party APIs, Slack/Telegram/email sends, deploys
(wrangler/kubectl/terraform), npm publish, GitHub API mutations (issue and PR
create/close/comment/merge, releases), external DB writes, payments, webhook
or cron registration, writes to paths outside the repo.

**The git exemption (hard rule).** Anything whose observable state lives in
git refs/objects is NOT a side effect: commits, branch moves, worktree file
writes, `git push`. Time travel already owns that state through jj. GitHub
*API* state (issues, PR metadata, comments, merge status) lives outside git
and IS a side effect. `gh pr view` / `gh issue list` / any read is never a
side effect. Reads in general (GET requests, queries) are never side effects.

**Effect status lifecycle.** Each recorded effect is exactly one of:

- `intended`: journal row written, execution started, not yet finished.
- `succeeded`: execution completed and reported success.
- `unknown`: execution failed OR the process died while `intended`. A tool
  that throws after its HTTP call already fired the effect; a crash mid-call
  is indistinguishable from a crash pre-call. Both collapse to `unknown` and
  the guard treats `unknown` exactly like `succeeded`. This is the answer to
  the "task failed on continue, did the effect happen?" race: we never guess.
- `reverted`: a registered revert handler completed for this effect.
- `revert-failed`: a revert handler ran and threw.
- `revert-stale`: the original call completed after compensation started or
  finished, so the effect is active again and the prior revert is no longer
  authoritative.

Only `succeeded` and `unknown` (and `revert-failed` or `revert-stale`) block
time travel.
`reverted` rows are inert. A row whose revert is in flight (`reverting`) when
assessed is treated as `unknown` revert state and the handler is re-run;
handlers are contractually idempotent (below).

## API surface (docs first)

### defineTool gains `revert`

```js
const postToSlack = defineTool({
  name: "post-to-slack",
  sideEffect: true,
  idempotent: false,
  inputSchema: z.object({ channel: z.string(), text: z.string() }),
  async execute(args, ctx) {
    return slack.chat.postMessage({ ...args, metadata: { key: ctx.idempotencyKey } });
  },
  async revert(args, ctx) {
    // ctx.effectStatus is "succeeded" or "unknown". Must tolerate both:
    // find-then-delete, never assume the effect exists.
    const msg = await findMessageByKey(ctx.idempotencyKey);
    if (msg) await slack.chat.delete({ channel: args.channel, ts: msg.ts });
  },
});
```

- `revert?: (args, ctx) => Promise<void>`. Declaring `revert` without
  `sideEffect: true` throws at definition time.
- Revert ctx: `{ output, effectStatus, idempotencyKey, runId, nodeId,
  iteration, attempt, toolCallSeq }`. `output` is the journaled output row
  (null when status is `unknown` and no output was captured).
- Contract (documented, eval-enforced): revert handlers MUST be idempotent
  and MUST tolerate `effectStatus: "unknown"` (verify-then-undo, never
  blind-undo). A revert that cannot verify should throw rather than guess.
- Tool metadata gains `hasRevert: boolean` (stamped alongside the existing
  `{ name, sideEffect, idempotent, acceptsIdempotencyKey }`).

### `<Task>` gains `sideEffect`

```tsx
<Task
  id="announce"
  sideEffect={{ idempotent: false, revert: async (ctx) => { /* verify-then-undo */ } }}
>
  {() => sendAnnouncement()}
</Task>
```

- `sideEffect?: boolean | { idempotent?: boolean; revert?: (ctx) => Promise<void> }`.
- Primary audience is compute tasks, which today are opaque to the tool-level
  machinery. Also legal on agent tasks as a coarse marking when the agent uses
  unmarked instruments (e.g. bash curl); tool-level marking stays preferred.
- `true` means `{ idempotent: false }`.
- Flows `TaskProps -> taskCore -> extract (both graph extract paths) ->
  TaskDescriptor.sideEffect -> engine`.
- For a side-effect task the engine journals one synthetic effect row per
  attempt (kind `task`): inserted `intended` when the attempt starts,
  `succeeded` when the attempt finishes, `unknown` on failure/crash. Same
  lifecycle, same guard, same revert plumbing as tool calls.
- Revert ctx for tasks: `{ outputRow, effectStatus, runId, nodeId, iteration,
  attempt }`.

### Journal: persist effect provenance

`_smithers_tool_calls` currently stores only `toolName` plus lifecycle; the
replay-unsafe gate has to re-derive side-effect flags from the live tool
registry. Persist them at call time so classification works forever, including
from the bare CLI with no workflow module loaded:

New columns (sqlite `ALTER TABLE ADD COLUMN`, nullable for legacy rows):
`kind` ("tool" | "task"), `side_effect` (0/1), `idempotent` (0/1),
`accepts_idempotency_key` (0/1), `has_revert` (0/1), `idempotency_key`,
`revert_status` (null | "reverting" | "reverted" | "revert-failed" |
"revert-stale"),
`reverted_at_ms`, `revert_error_json`, `forced_past_json` (records each
forced crossing: opId, timestamp, operation).

Legacy rows (all-null flags): classified via the loaded workflow's tool
registry when available; otherwise reported as `unclassified` warnings in the
report but NOT blocking (a hard block would brick time travel on every
pre-existing run). New rows always carry flags.

Retention across time travel: journal rows for discarded attempts are never
deleted. Rows whose attempt is discarded move to (or are marked in place as)
archived state with the operation id, preserving the record that the world
saw the effect. Live-vs-archived must also solve the PK collision: after a
reset the node re-runs at attempt 1 and would collide with the retained
row's `(runId, nodeId, iteration, attempt, seq)` PK. Move discarded rows to
`_smithers_tool_call_archive` (same columns + `archivedByOp`, `archivedAtMs`,
`archiveReason`) in the same txn as the truncation. Archived rows never block
again: a previously forced-past or reverted effect is a recorded fact, not a
new blocker; later assessments surface archived non-reverted effects as
"previously forced" warnings in the report only.

### The guard

New in `packages/time-travel`: `assessEffectBoundary(db, params)` where
params identify the discard set (cutoff ms for revert/timetravel, exact
attempt set for jumpToFrame, horizon for fork/replay). Returns:

```ts
type EffectBoundaryReport = {
  blocking: CrossedEffect[];    // succeeded/unknown, no usable revert
  revertible: CrossedEffect[];  // succeeded/unknown, hasRevert
  warnings: CrossedEffect[];    // unclassified legacy, previously forced
};
type CrossedEffect = {
  kind: "tool" | "task"; toolName: string; nodeId: string; iteration: number;
  attempt: number; seq: number; effectStatus: "succeeded" | "unknown";
  idempotent: boolean; hasRevert: boolean; startedAtMs: number;
};
```

Semantics per operation:

| Operation | Discards history? | Guard | Runs reverts? |
|---|---|---|---|
| `revert` | yes | error unless covered/forced | yes |
| `timetravel` | yes | error unless covered/forced | yes |
| `rewind` (jumpToFrame) | yes | error unless covered/forced | yes |
| `replay` | no (new run) but auto-resumes past boundary | error unless `--force` | never |
| `fork --run` | same as replay | error unless `--force` | never |
| `fork` (no run) | no | warning in output + child event | never |
| `restore` (fs only) | no | none | never |

Discard operations: effects in `revertible` are automatically compensated
(registering `revert` is precisely opting into "time travel may undo this").
Reverts run in reverse chronological order, each journaled
`reverting -> reverted | revert-failed`, BEFORE any VCS mutation or DB
truncation. Any `revert-failed` aborts the whole operation with the report;
nothing has been truncated, so the run is untouched apart from journal
status. Remaining `blocking` effects (no handler, or `--no-revert` passed)
raise `TIME_TRAVEL_SIDE_EFFECT_BLOCKED` unless `--force`.

Branch operations (replay, fork --run) never run reverts: the parent
timeline still owns those effects; compensating them would corrupt the
parent's world. They block on any crossed `succeeded`/`unknown` effect
because auto-resume will re-execute effect-bearing tasks (double-fire risk),
`--force` bypasses.

Reporting is unconditional. Blocked, forced, or cleanly reverted, the CLI
prints the effect table (tool/task, node, status, disposition) and MCP/RPC
results carry the structured `EffectBoundaryReport`. A forced crossing
additionally writes a durable `SideEffectBoundaryCrossed` event on the run,
stamps `forced_past_json` on each crossed row, and marks the run
needs-attention so `smithers why`/`status` surface it later. The agent can
force its way through, but the user always finds out.

New error code: `TIME_TRAVEL_SIDE_EFFECT_BLOCKED` (packages/errors; note the
hand-edit precedent for its generated d.ts). New events: `EffectRevertStarted`,
`EffectRevertFinished`, `EffectRevertFailed`, `SideEffectBoundaryCrossed`
(revert event group in docs/runtime/events.mdx).

### CLI flags

- `revert`, `timetravel`, `rewind`, `replay`, `fork`: gain the guard.
  `--force` bypasses remaining blockers (timetravel's existing `--force`
  meaning, "operate on a running run", is unchanged and now also covers the
  effect boundary; one flag, both meanings, reported distinctly).
- `--no-revert` (discard ops only): skip registered handlers; effects then
  count as blocking and need `--force`.
- MCP semantic tools (`revert_attempt`, `time_travel`, `rewind_run`,
  `replay_run`, `fork_run`) accept `force` / `noRevert` params and return the
  report. The gateway route additions are optional params on existing
  methods, not new methods, to keep the RPC-contract churn bounded (still:
  rpc-contract test, openapi regen, gateway-client types, docs/rpc pages).

### Revert execution environment

Discard-time reverts need the handler code. The operation loads the workflow
module exactly as resume does (resume metadata entry file), renders the graph
(no execution) to collect tool definitions and task descriptors, and resolves
each crossed row to its handler: tools by `toolName` via the collected
defined-tool metadata; tasks by `nodeId` via the rendered descriptor tree. If
the module cannot be loaded or the handler cannot be resolved (workflow file
edited since; hash mismatch), the affected effects degrade from `revertible`
to `blocking` with an explanatory reason in the report. Never guess a
handler.

## Race conditions (explicit design answers)

1. **Effect fired, journal never updated (crash mid-call).** Row stuck
   `intended` -> status `unknown` -> blocks time travel; revert handler (if
   any) is invoked with `effectStatus: "unknown"` and must verify-then-undo.
2. **Task fails on resume, effect unclear, then user reverts.** Forward path:
   engine resume cancels the in-flight attempt; the existing
   `ReplayUnsafeApproval` gate pauses before re-execution. Backward path: the
   `unknown` row blocks the revert. Both directions refuse to guess.
3. **Crash during handler reverts.** Rows are individually journaled;
   `reverting` rows are re-run on the retried operation (handlers idempotent
   by contract). Nothing was truncated yet, so retrying the operation
   converges.
4. **Crash after reverts, before truncation.** Rows read `reverted`, the
   retried operation assesses clean and proceeds straight to truncation.
5. **Concurrent time travel vs live engine.** Reuse the rewind lease
   machinery (`rewindLock`/`rewindAudit`) for revert and timetravel discard
   paths too: one lease per run, audit rows with in-progress recovery, and
   the existing "running run requires `--force`" check stays.
6. **Double compensation.** `reverted` rows are inert to later assessments;
   a re-executed task after time travel writes fresh journal rows at the new
   attempt epoch (archive table prevents PK collision), so a later travel
   sees only the new facts.
7. **Replay/fork double-fire.** Branch ops re-execute effect-bearing tasks
   with fresh attempt numbering (attempt 1: replay-unsafe gate does not
   trigger). That is exactly why they get the boundary guard at launch time.

## Forward-path unification (retry gate)

The existing `ReplayUnsafeApproval` machinery keeps its behavior but reads
the persisted per-row flags instead of re-deriving from the live registry,
covers `kind: "task"` synthetic rows (a side-effect compute task that crashed
mid-attempt gates re-execution the same way), and its agent warning message
mentions registered revert handlers. Idempotency-key-capable tools keep
today's soft path (warning injection, no gate).

## Enforcement: agents must mark side effects

Runtime guarding only works if authored workflows mark effects. Two layers:

### Deterministic analyzer (packages/scorers)

`packages/scorers/src/sideEffectAnalysis.js`: pure static analysis over
candidate workflow source (TypeScript AST, following the
`workflowUiCompliance.js` shape). It detects effectful sites:

- network mutations: `fetch`/axios/ky with POST/PUT/PATCH/DELETE;
- known-CLI mutations in exec/spawn/bash strings: `gh` mutating verbs
  (`pr merge/close/comment`, `issue create/close/comment`, `api -X POST...`,
  `release create`), `wrangler deploy/publish`, `kubectl apply/delete/scale`,
  `terraform apply`, `npm publish`, `flyctl deploy`, `aws`/`gcloud` mutating
  verbs, `curl -X POST...`;
- SDK effect calls: slack `chat.postMessage`, nodemailer `sendMail`, stripe
  create/charge/refund, twilio `messages.create`, telegram `sendMessage`,
  s3 `putObject`, pagerduty/sentry event posts;
- out-of-repo filesystem writes (absolute paths outside the repo root).

And the exemption list: git/jj commands, `gh` read verbs (view/list/status),
GET requests, in-repo writes. Output:
`gradeSideEffectCompliance(source, expectation) -> { passed, score, violations }`
with violation kinds `unmarked-effect`, `over-marked-pure`,
`missing-idempotency-key`, `missing-revert`, `revert-without-side-effect`.
The ruleset lives in one data module so evals and future lint share it.
The analyzer is conservative and versioned; every rule has unit tests, and a
fixture corpus in CI pins its judgments with zero model spend.

### Eval corpus (hundreds of cases, deterministic grading)

New verify kind `side-effect-marking` in `evals/lib/verify.ts` (registered in
the `VerifyKind` union and the `eval-kit.tsx` enum), delegating to the
analyzer. Zero model spend in the verify task.

New suite `evals/suites/authoring-side-effects/` (standard
`createFluencyEval` wrapper) whose `cases.jsonl` is generated by
`evals/harness/generate-side-effect-cases.ts` from a scenario data table
(`scenarios.ts`, checked in). Scenario axes:

- Effect classes from the real corpus survey (awesome-smithers, examples/,
  .smithers/workflows): messaging (slack/telegram/email/discord), social
  posting, GitHub API mutations (the dominant real class), deploys
  (wrangler/kubectl/terraform/fly), package publish (npm/docker), external
  DB and object storage, payments (stripe charge + refund-as-revert),
  webhook/cron registration, incident tooling (pagerduty/sentry).
- Negative classes: git-only sweeps (commit/push/branch), pure analysis/ETL,
  in-repo codegen, read-only API dashboards. Over-marking fails.
- Adversarial classes: looks-effectful-but-pure (`gh pr view`, GET fetch,
  `wrangler deploy --dry-run`, `terraform plan`), looks-pure-but-effectful
  ("save the report" that posts to Slack, "log metrics" that POSTs),
  git-vs-GitHub boundary (push branch = unmarked, merge PR = marked),
  mixed workflows with both marked and unmarked steps.
- Variant axes: tool-based vs compute-task marking; revert handler required
  or not; idempotency-key threading required or not.
- Model matrix: each scenario fans across the weak-model matrix
  (`evals/agents.ts`), the repo's standard multiplier.

Target: >= 100 distinct scenarios x 3+ models >= 300 generated authoring
cases, plus ~40 handwritten adversarial cases, plus a fixture corpus
(~60 pre-written candidate workflows, half correct half wrong) graded by a
plain `bun test` in CI so the analyzer itself is regression-gated on every
PR without any model. Baselines run via the existing
`evals/harness/run-suite.ts`; record a baseline scorecard like
`research/authoring-benchmark-baseline.md`.

Also add revert-authoring cases: "build a workflow that posts X and supports
clean time travel" must produce a `revert` handler whose body is
verify-then-undo. The analyzer must prove that a known `succeeded` effect is
undone, while an `unknown` effect is probed and undone only in the branch where
the external object is verified present. Status mentions without branch
coverage and inverted existence guards fail.

## Test plan (core runtime)

Extreme-bar rules apply: failing tests first, full cross-product, then an
adversarial "what combination has no test" pass.

- packages/tool-context: revert validation, metadata stamping, ctx shape.
- packages/db: migration forward from a seeded old DB; schema-head test
  updates; archive table round-trip.
- packages/components + graph: prop -> descriptor extraction in both extract
  paths; boolean and object forms; agent + compute + static kinds.
- packages/engine: journal stamping cross-product (tool/task x
  succeed/fail/crash -> intended/succeeded/unknown); synthetic task rows;
  replay-unsafe gate off persisted flags; legacy-row classification.
- packages/time-travel: `assessEffectBoundary` cross-product (status x
  idempotent x hasRevert x archived x forced x legacy); per-operation
  semantics table above as tests; revert ordering (reverse chronological);
  revert-failed aborts pre-truncation; archive move + PK collision
  regression; crash injection between reverts and truncation (re-run
  converges); lease reuse.
- apps/cli e2e: blocked / `--force` / `--no-revert` / clean-revert flows for
  revert, timetravel, rewind, replay, fork; report always printed; forced
  crossing emits event + needs-attention; MCP result carries the report.
- docs: task.mdx sideEffect prop, defineTool revert (recipes + how-it-works),
  time-travel guide section, events.mdx revert group additions, CLI pages
  for the five commands, new RPC param docs; then `pnpm docs:llms`.

## Implementation checklist by package

1. packages/tool-context: `revert` option, validation, metadata.
2. packages/db: journal columns + `_smithers_tool_call_archive` + migration
   (update schema-head assertions in gateway-shared-db/migrateSmithersStore
   tests).
3. packages/components/graph: Task `sideEffect` prop through both extract
   paths into TaskDescriptor.
4. packages/engine: persist flags on `recordToolCall`/defineTool wrapper;
   synthetic task-effect rows; unify replay-unsafe gate onto persisted
   flags.
5. packages/time-travel: `assessEffectBoundary` (own file, one export),
   revert executor, wiring into revert.js / timetravel.js / jumpToFrame.js /
   forkRunEffect.js / replayFromCheckpointEffect.js; lease + audit reuse.
6. packages/errors: `TIME_TRAVEL_SIDE_EFFECT_BLOCKED` (hand-edit d.ts per
   precedent, update error-declarations test).
7. packages/protocol/server/gateway: event types, optional RPC params,
   rpc-contract + gateway-client + openapi + docs/rpc updates.
8. apps/cli: flags, report rendering, MCP semantic-tool params.
9. packages/scorers: `sideEffectAnalysis` + `gradeSideEffectCompliance` +
   barrel export.
10. evals: verify kind, suite, generator, scenarios table, fixtures + CI
    test, baseline scorecard.
11. docs + `pnpm docs:llms` (regenerate in a clean tree).

House rules: one named export per file, colocate by domain, no em-dashes in
docs, docs-driven (update mdx before or with code), never gate on an agent's
self-reported side effect.

## Out of scope

- Runtime detection of side effects inside agent bash sessions (undecidable;
  the convention + evals + coarse Task marking cover it).
- Automatic undo synthesis; reverts are always author-written.
- Cross-run effects on shared external state.
- Blocking legacy runs with unclassifiable journal rows.
