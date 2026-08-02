# Workflow testing library (`smthrs/testing`)

Status: proposed. Author: will@tevm.tech (+ Claude). Date: 2026-07-03.
Target package version at time of writing: 0.26.1.

This is the full design spec. The filable GitHub-issue summary lives alongside it
and links here. Terminology and API names here are canonical.

## Goal

Raise the probability that a smithers workflow works on its first real run. A
workflow can fail for reasons that are all knowable before any agent spends a
token:

- a prompt that renders wrong (MDX props, entity escaping, `[object Object]`),
- a `deps` key that maps to a node id nothing produces (silent
  `DEPENDENCY_DEADLOCK`),
- a schema mismatch between what one task emits and what the next task reads,
- a `<Loop until>` that reads `outputMaybe` (current iteration) instead of
  `latest` (highest iteration), so it never advances,
- an approval gate whose activation condition never becomes true,
- a compute task that throws and then retries forever (compute `retries`
  default to `Infinity`).

Today the only ways to catch these are: `smithers graph` (renders one frame,
catches load-time bugs only), the fake-binary CLI e2e harness (high fidelity but
heavyweight and internal), `smithers eval` (spends model tokens, built for
grading fluency), or shipping and watching the run fail.

We also have no way to state an expectation the type system cannot capture, for
example "after the triage task runs, more than one ticket exists", and have it
enforced both in tests and during real runs. Scorers observe but never gate
(`runScorersAsync` is fire-and-forget, `engine.js:4406`); no assertion or
invariant surface exists in components, driver, or engine.

The library makes workflow tests fast (milliseconds, no DB, no subprocess for
the common tiers), typed (mock values validated against each task's real output
table before anything runs), and adds an assertion primitive that runs in tests
and at runtime alike.

## Ground truth (verified against source)

Everything below was checked against the codebase; file:line references are the
evidence. This section is what the design stands on.

### Seams we build on

| Seam | Where | What it gives us |
|---|---|---|
| `AgentLike` is a structural duck type `{ generate(args): Promise<unknown> }` | `packages/agents/src/AgentLike.ts` | A fake agent is just an object. Engine tests already pass `{ generate: async () => ({ text: '...' }) }` inline (`packages/engine/tests/engine-workflow.test.jsx:36`). |
| The engine hands `generate()` a worktree-aware `rootDir` and records a jj pointer per attempt for every task kind | `engine.js:3647`, `engine.js:4343` | A fake agent that writes files into `rootDir` gets its file changes recorded like a real agent. File-change mocking needs no engine change. |
| `WorkflowDriver` + `makeWorkflowSession` run the whole decision loop fully in memory; session keeps state in `Map`s, never reads `options.db`; `executeTask` is injectable | `packages/driver/src/WorkflowDriver.js:292`, `packages/scheduler/src/makeWorkflowSession.js` | The simulation tier: run a workflow's entire control flow against mocked task results in milliseconds, no DB. |
| Session stepwise API exists with these exact names: `approvalResolved` (`:906`), `eventReceived` (`:932`), `signalReceived` (`:936`), `timerFired` (`:940`); `getTaskStates` (`:1029`) | `makeWorkflowSession.js` | Drivable approvals, signals, timers from a test. `pendingApprovals` derives from scanning `getTaskStates()` for `waiting-approval` keys. |
| The driver maps `Wait` reasons to `status: "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota"` and returns terminal on first `Wait` | `WorkflowDriver.js:608-633` | Assertable suspension. Stepwise mode needs an `onWait` handler or direct session driving plus loop re-entry (see Simulation tier). |
| `build(ctx)` runs with a hand-built `SmithersCtx` and no DB; `schemaRegistry` and `zodToKeyName` live on the workflow object | `SmithersCtx.js:73-102`, `create.js:279-287`, `WorkflowDefinition.ts:14-15` | The render and simulation tiers construct their own ctx without opening a database. |
| `renderFrame` re-exported from the engine barrel drags in `bun:sqlite`; the Node-clean render path is `SmithersRenderer` + `extractGraph` + hand-built `SmithersCtx` (these `src/` trees have zero `bun`/`@effect/platform-bun` references) | `extractGraph` `packages/graph/src/extract.js:342`, `SmithersRenderer` `packages/react-reconciler/src/reconciler.js:459` | Tier 1 must use the reconciler + graph packages directly and never import `renderFrame`. |
| `runWorkflow(workflow, opts): Effect<RunResult>` runs the real engine against a temp sqlite db; `createTestSmithers(schemas)` exists | `engine.js:6067`, `packages/smithers/tests/helpers.js` | The engine tier: full-fidelity integration tests under bun. |
| Engine prefers `result._output ?? result.output` before any JSON extraction; text-fence extraction and the schema-retry ladder (cap `MAX_SCHEMA_RETRIES = 3`) run only when `output` is undefined | `engine.js:3806-3813`, `:4157` | Engine tier: a mock returning `{ output }` skips parsing; `{ text }` exercises extraction plus schema retry. |
| Fake CLI binaries plus `SMITHERS_TEST_AGENT_PATH` plus `SMITHERS_FAKE_AGENT_RESPONSE` | `packages/smithers/tests/e2e-helpers.js`, `.smithers/agents.ts:7` | The e2e tier already exists internally: real adapters, real CLI. The testing package re-exports it. |
| `zodSchemaToJsonExample(schema)` | `packages/components/src/zod-to-example.js` | Free auto-mock generator: schema to plausible placeholder row. Powers `auto` and `smithers simulate`. |
| Deterministic assertion vocabulary in eval-suite (`expected.{status,output,outputContains,errorContains}` to `{passed, assertions[]}`) | `apps/cli/src/eval-suite.js` | Matcher semantics to reuse so eval and workflow tests agree. |

### Hard constraints (these shape the whole design)

1. **The `smthrs` barrel pulls `bun:sqlite` at module load.** The
   barrel re-exports the engine (`packages/smithers/src/index.js:196-206`); the
   engine index statically imports `bun:sqlite` via
   `packages/engine/src/effect/builder.js:1` and imports
   `@effect/platform-bun/BunContext` (`engine.js:34`). So
   `import { createSmithers } from "smthrs"` (what every seeded
   workflow does) evaluates `bun:sqlite` under Node, before any DB opens.
   Deferring the `new Database()` call inside `create.js` does not help. Making
   a workflow importable under Node needs a Node-clean authoring subpath, see
   `smthrs/define` below.

2. **Nine seeded workflows `import { $ } from "bun"` at module scope** and cannot
   be imported under Node regardless of the barrel:
   `triage-run, monitor, monitor-smithers, post-failure, create-workflow,
   make-workflow-tutorial, report-slideshow, build-tui-monitor, smithering`.
   Their compute tasks shell out to live `bunx smthrs` and write
   files, so "compute runs real" is not sub-second or side-effect-free for them.

3. **`packages/driver`, `packages/scheduler`, `packages/react-reconciler`,
   `packages/graph`, `packages/components` are Node-clean** (zero Bun globals).
   The render and simulation tiers depend only on these, so they run under
   Node/vitest as long as the workflow module itself is Node-importable.

4. **`defaultTaskExecutor` does not call `generate`.** For an agent it
   duck-calls `execute`/`run`/`call` only; an object with just `generate` falls
   through to `return task.prompt ?? null` (`defaultTaskExecutor.js:20-27`). The
   simulation harness therefore supplies its own executor that looks up the mock
   by node id and calls it; it never routes mocks through `defaultTaskExecutor`.
   Compute is called bare (`task.computeFn()`, no `withTaskRuntime`); seeded
   compute fns do not use the task runtime, so bare-driver compute is fine.

## Design

One new package, `packages/testing` (`@smthrs/testing`), shipped
as source TypeScript with no dts build (same pattern as
`@smthrs/gateway-client`, `electric-proxy`, `pi-plugin`). The
definition-time `z.infer` generics are the headline feature, so a hand-written
`.d.ts` that could drift is the wrong choice. Subpaths:

- `smthrs/testing` — Node-clean core (render + simulation tiers,
  fake agents, matchers).
- `smthrs/testing/engine` — bun-only engine tier.
- `smthrs/testing/e2e` — re-export of the existing fake-binary
  CLI harness.
- `smthrs/testing/vitest` — the `smithersTest()` vitest plugin.

The core is runner-agnostic: plain async functions plus data, with value
matchers registered through `expect.extend` in both vitest and bun test. Type
augmentation ships per runner (`declare module "bun:test"` Matchers and vitest's
`Assertion`/`AsymmetricMatchersContaining`), since matcher typing is not
portable. Custom snapshot matchers are not portable either (they need the
runner's internal snapshot state), so we do not ship one; we expose
`frame.toXml()` and let authors use each runner's built-in `toMatchSnapshot()`.

Three execution tiers behind one mock vocabulary:

```
tier 1  renderWorkflow()   render one frame, no execution        Node + Bun (needs Node-importable workflow)
tier 2  simulate()         full control flow, in-memory, mocked  Node + Bun (needs Node-importable workflow)
tier 3  testWorkflow()     real engine, temp DB, real files      Bun only (smthrs/testing/engine)
        e2e (existing)     real CLI + fake binaries               re-exported from /testing/e2e
```

Under `bun test`, all tiers work for every workflow today. Under vitest on Node,
tiers 1 and 2 work for workflows that are Node-importable, which requires the
`smthrs/define` authoring subpath (M6) and, for bun-coupled
workflows, moving their shell-outs behind a portable seam.

### 1. Fake agents

```ts
import { fakeAgent, auto } from "smthrs/testing";

// A standalone AgentLike whose output is TYPED and safeParse-validated when the
// fake is defined. Use this to inject into an `agent` prop or an agents pool.
const triage = fakeAgent(ticketsSchema, {
  output: { summary: "3 flaky tests", tickets: [{ id: "T-1" }, { id: "T-2" }] },
  files: { "src/fix.ts": "export const fixed = true;" }, // written into rootDir
});

// Engine-tier vocabulary: exercise the JSON-extraction ladder and schema retry
// instead of the structured fast path. In the simulation tier `{ text }`
// resolves to raw unparsed output (the sim has no extraction ladder).
const sloppy = fakeAgent(ticketsSchema, { text: "Sure! ```json\n{...}\n```" });

// Scripted: receives what the engine actually passes generate().
const scripted = fakeAgent(ticketsSchema, async ({ prompt, rootDir }) => {
  expect(prompt).toContain("triage");
  return { output: { summary: "ok", tickets: [] } };
});

// Sequence for loops/retries: each generate() call consumes the next entry.
// Note the engine can call generate() more than once per attempt (up to 3
// schema retries plus a follow-up JSON request on extraction failure), so
// sequences target the engine tier deliberately.
const flaky = fakeAgent.sequence(reviewSchema, [
  { output: { approved: false } },
  { output: { approved: true } },
]);

flaky.calls;        // recorded { prompt, options } per call
flaky.lastPrompt(); // assertion sugar
```

`fakeAgent` returns a real `AgentLike` plus the `id`/`model` fields the engine
sniffs, so it can be an `agent` prop, a pool member, or a `mocks` entry. The
repo's own vocabulary is "fake agent" / "fake binaries" (see the no-mocks
section of `CLAUDE.md` and `writeFakeClaudeBinary`); "fake" also reads correctly
against the no-mocks policy.

`auto` is a sentinel (optionally `auto({ seed })`) that fills any unmocked agent
task from its output schema via `zodSchemaToJsonExample`.

### 2. Simulation tier: `simulate()`

Runs the real `WorkflowDriver` plus `makeWorkflowSession` with an injected
executor that the harness owns (not `defaultTaskExecutor`). The executor:

- runs compute and static tasks with their real code (pure compute is what we
  want to test), unless a mock targets that node,
- for an agent task, looks up the mock by node id and calls
  `mock.generate({ prompt: task.prompt, outputSchema: task.outputSchema, rootDir, ... })`,
- for a compute or IO task that is mocked, returns the mock value directly.

No DB, no network. A full multi-iteration workflow simulates in milliseconds
when its compute is pure. For bun-coupled compute (triage-run/monitor shell-outs)
the author supplies a compute mock, or runs the sim under bun where `$` works
(then it is not subprocess-free; see the compute-mock note).

One entry point returning a handle. `await sim.run()` runs to completion; the
stepwise methods drive waits.

```ts
import { simulate, auto } from "smthrs/testing";
import workflow from "../workflows/triage-run";

const sim = simulate(workflow, {
  input: { targetRunId: "run-fixture-1" },
  mocks: {
    // Bare object: validated against the node's real output table at simulate()
    // time (before running). No schema import needed; the workflow carries the
    // registry. Channel is the node id.
    diagnose: { health: "unhealthy", anySelfFixable: true },
    // Function mock: full access to per-call context.
    recommend: ({ iteration }) => ({ action: "retry", command: "smithers retry-task ..." }),
    // Compute override for the bun shell-out node so the sim stays fast.
    gather: { events: [], status: "running" },
    // Fill every remaining agent task from its schema.
    "*": auto,
  },
  clock: { mode: "auto" }, // auto advances to the next due timer/backoff instant
});

await sim.run();

expect(sim.status).toBe("finished");
expect(sim).toHaveExecutedInOrder(["gather", "diagnose", "recommend", "output"]);
expect(sim.output).toMatchObject({ action: "retry" });
expect(sim.outputs.diagnose).toHaveLength(1); // typed via the workflow's schema record
expect(sim).toStayUnderRenderBudget(8);       // re-render budget, not an exact count
```

Determinism guarantee (stated so tests can rely on it): the simulation awaits
mocked executions in schedule order, single threaded, so `sim.executed`
(completion order) is stable run to run.

Typed access. `simulate<S>(workflow: SmithersWorkflow<S>, opts: SimOptions<S>)`
threads the workflow's schema record `S`:

```ts
type Sim<S> = {
  outputs: { [K in keyof S as S[K] extends z.ZodObject<any> ? K : never]: Array<z.infer<S[K]>> };
  input: S extends { input: infer I } ? NullableDeep<z.infer<I>> : unknown;
  // ...
};
```

`input` is `NullableDeep` because the engine delivers unsupplied input fields as
`null`, and zod `.default()` does not apply at runtime. `simulate()`
null-fills unsupplied schema fields to match engine behavior, so a test cannot
pass where production nulls break. `inputFromArgv(workflow, ["--name", "Ada"])`
reuses the CLI flag parser to test the `workflow run` path.

Strictness rules (this is where first-run failures surface early):

- An unmocked agent task is a loud failure listing the workflow's actual
  agent-task node ids (node ids are runtime strings, so this runtime check is the
  typesafety backstop the type system cannot give).
- A mock value that fails `safeParse` against the node's real output table is a
  loud failure naming the node and the zod issues.
- `Finished` with unresolved deferred deps surfaces `DEPENDENCY_DEADLOCK` with
  the waiting node ids (built in, `makeWorkflowSession.js:851`).
- Unused mocks and never-hit sequence entries are reported in `sim.unusedMocks`.

Mock keying and matching:

- Keys are node ids. Precedence is exact, then glob (`"review-*"`), then `"*"`.
  Real generated ids: Panel produces `review-panelist-0`
  (`packages/components/src/components/Panel.js:43`), legacy Review produces
  `review:0` (`.smithers/components/Review.tsx:63`). Globs cover both.
- `"*"` and `auto` match agent tasks only; compute and static run real unless a
  mock targets them specifically.
- Function mocks receive `MockCall = { nodeId, iteration, attempt, prompt,
  rootDir, outputSchema }`, so per-iteration mocking is explicit
  (`review: ({ iteration }) => ({ approved: iteration >= 2 })`) and does not
  conflate schema-retry attempts with loop iterations.
- Route by agent identity as an alternative to node ids (natural for Panels with
  many generated ids), matched against the descriptor's `agent`:
  `agentMocks: [{ agent: agents.smart, mock: ... }]`.

Stepwise mode for gate, loop, and signal tests. A bare `WorkflowDriver.run()`
returns terminal on the first `Wait`, so the handle drives the session directly
and re-enters the loop:

```ts
const sim = simulate(workflow, { input, mocks });
await sim.until("waiting-approval");
expect(sim.pendingApprovals).toEqual([{ nodeId: "approve-fix" }]);
sim.deny("approve-fix", { note: "not in prod" });
await sim.done();
expect(sim).not.toHaveExecuted(["fix"]); // onDeny="continue" skipped the fix arm
```

Clock control (`clock: { start?, mode: "auto" | "manual" }`): the scheduler
gates retries on `retryWait vs nowMs()` (`makeWorkflowSession.js:577`) and timers
on `resumeAtMs`, so a frozen clock can wedge backoff. Auto mode jumps to the next
due instant when nothing else is runnable. Manual mode exposes
`sim.clock.advance("15m")` and `sim.clock.runToNextTimer()`. `Date.now()` inside
user compute fns is not controlled; document this.

Handle surface: `sim.run()`, `sim.until(state)`, `sim.done()`, `sim.approve(id)`,
`sim.deny(id)`, `sim.signal(name, payload)`, `sim.cancel()`, `sim.clock.*`,
`sim.status`, `sim.output`, `sim.outputs.<channel>`, `sim.executed`,
`sim.task(id)` (`{ status, attempts, prompts, outputs, iterations }`),
`sim.assertions`, `sim.warnings`, `sim.unusedMocks`, `sim.segments` (for
continue-as-new, mocks and clock carry across; `maxContinues` caps eternal
workflows and `toHaveContinuedAsNew(n)` asserts on them).

### 3. Render tier: `renderWorkflow()`

Node-clean wrapper over `SmithersRenderer` + `extractGraph` + a hand-built
`SmithersCtx` (never `renderFrame`, which is in the engine). This is the unit
test story for prompts and render logic, including single-task tests.

```ts
const frame = await renderWorkflow(workflow, {
  input: { name: "Ada" },
  outputs: { greeting: [{ nodeId: "greet", greeting: "Hi Ada" }] }, // pretend upstream finished
});

frame.taskIds;                       // ["greet", "output"] (output mounted because greeting exists)
frame.task("greet").prompt;          // rendered MDX to markdown text
frame.task("greet").agentChain;      // resolved AgentLike[]
frame.task("output").dependsOn;      // resolved deps
expect(frame.toXml()).toMatchSnapshot(); // built-in snapshot, portable

// Single task: render then execute exactly one descriptor.
const result = await runTask(workflow, "output", { input, outputs: seeded });
expect(result.output).toEqual({ greeting: "Hi Ada", name: "Ada" });

// Standalone prompt test: no workflow mount.
const text = await renderPrompt(<HelloPrompt name="Ada" />);
expect(text).toMatchSnapshot();
```

One persistent `SmithersRenderer` per harness instance so hook state behaves
like the engine (the engine keeps one renderer per run; fresh-per-render resets
hooks, a documented trap).

### 4. Engine tier: `testWorkflow()` (`smthrs/testing/engine`, bun only)

Same mock vocabulary, real engine: temp-dir sqlite via a `createTestSmithers`
fixture, real output validation and schema-retry ladder, real approvals
(`approveNode`/`denyNode` wrapped as `run.approve(nodeId)`), real file capture in
a jj temp workspace with diff assertions.

```ts
import { testWorkflow, createTempWorkspace } from "smthrs/testing/engine";

const ws = await createTempWorkspace({ jj: true });
const run = await testWorkflow(workflow, { input, mocks, rootDir: ws.dir });
expect(run.status).toBe("finished");
expect(run.diff("implement")).toMatchFiles({ "src/fix.ts": /fixed = true/ });
```

`run.diff(nodeId)` is synchronous (diffs materialized when the run finishes) so
`toMatchFiles` is a sync matcher and there is no unawaited-async silent-pass
footgun.

To route mocks to agent tasks without editing the workflow, the engine gains one
seam: `RunOptions.resolveAgent?(task: TaskDescriptor, chain: AgentLike[]) =>
AgentLike | AgentLike[] | undefined`, consulted before attempt-indexed selection
at `engine.js:3127`. It is a general runtime hook (also useful in ops: force a
different agent for one node on resume), threaded down through
`executeTaskBridgeEffect` into `legacyExecuteTask`. The simulation tier does not
need it (its executor never reaches agent selection). Workflows using the factory
pattern (`createOpenCodeReviewWorkflow(reviewAgents)`) or module-level `agents`
substitution do not need it either; it is the escape hatch for testing
seeded/legacy workflows as authored.

The existing e2e helpers (`createTempRepo`, `runSmithers`, `writeFakeClaudeBinary`,
and so on) re-export under `smthrs/testing/e2e`.

### 5. Assertions that run in tests and at runtime

Two new primitives.

(a) `invariants` prop on `<Task>`, like `scorers` but blocking. Runs after output
validation on the freshly produced row, with a read-only ctx snapshot:

```tsx
<Task id="triage" output={outputs.tickets} agent={agents.smart}
  invariants={{
    producesMultipleTickets: ({ row }) => row.tickets.length > 1,
    ticketsHaveOwners:       ({ row }) => row.tickets.every(t => t.owner),
  }}>
  <TriagePrompt />
</Task>
```

Retry semantics differ by task kind, which the design must state because compute
`retries` default to `Infinity`:

- On an agent task, a failed invariant threads its message into the schema-retry
  loop (`engine.js:4341`, right after `validation.ok`). This is the only
  mechanism that feeds corrective text into a follow-up prompt, it resumes the
  same conversation, and it is capped at `MAX_SCHEMA_RETRIES = 3`. The
  invariant check joins that cap.
- On a compute or static task, a failed invariant fails immediately and does not
  retry (a deterministic function cannot produce a different row). Prompt
  feedback does not apply.

Guidance: a pure single-row check that needs no run context should be a
`.refine()` on the output schema, which rides the existing schema-retry loop for
free. Reserve `invariants` for checks that read the run context.

(b) `<Assert>` component, a first-class graph node for cross-task expectations:

```tsx
<Sequence>
  <Task id="triage" output={outputs.tickets} agent={agents.smart}>…</Task>
  <Assert id="tickets-cover-plan"
    that={(ctx) =>
      (ctx.outputMaybe("tickets", { nodeId: "triage" })?.tickets.length ?? 0) ===
      (ctx.outputMaybe("plan",    { nodeId: "plan"   })?.items.length   ?? 0)}
    message="every plan item must get a ticket"
    onFail="fail"   // or "warn"
  />
  <Task id="assign" … />
</Sequence>
```

Implementation: `<Assert>` renders to a compute task with `retries={0}` pinned
(critical: otherwise an assert retries forever). Results are stored in a
dedicated internal table `_smithers_assertions` via a new adapter method
`insertAssertionResult(row)`, mirroring how scorers use `insertScorerResult`
(`packages/db/src/adapter.js:3178`). This is not a `createSmithers` output
channel: user channels are fixed at construction (`create.js:377`) and cannot be
injected by a later-rendered component, and they are not internal. `onFail="fail"`
throws `ASSERTION_FAILED`; `onFail="warn"` writes the row with `passed: false`,
`level: "warn"`, and emits an `AssertionWarned` run event visible in
`smithers events`/inspect/UI.

Because `<Assert>` is an ordinary task, it behaves identically in simulation,
engine runs, and production: the same assertion guards the test and the 3am run.
In the simulation tier (no adapter) results collect in memory for the matchers.

Matchers: `toPassAssertions({ strict })` (warns pass by default; `strict: true`
includes them), `toHaveFailedWith("ASSERTION_FAILED")`. New error codes
`INVARIANT_FAILED` and `ASSERTION_FAILED` in `packages/errors` with
`details.{invariant | assertId, nodeId, message}`.

### 6. `smthrs/define`: the Node-clean authoring subpath

This is the enabler for vitest on Node and a smithers improvement in its own
right. Today `import { createSmithers } from "smthrs"` evaluates
`bun:sqlite` under Node because the barrel re-exports the engine. `define`
exposes only what authoring needs: `createSmithers`, the bound components,
`outputs`, `useCtx`, `smithers`. It does not re-export the engine, and it loads
`bun:sqlite` through a dynamic `import()` on first DB access (so `api.db` still
works under bun, and workflows that never touch `api.db` at import time load
cleanly under Node). Seeded workflows migrate their import to
`smthrs/define`; the barrel keeps re-exporting `createSmithers`
for back-compat but is no longer the recommended authoring import.

Side benefits beyond testing: faster `smithers graph`, lighter workflow module
loads everywhere, and workflows become importable by any Node tool.

Bun-coupled workflows (the 9 that `import { $ } from "bun"`) additionally need
their CLI shell-outs behind a portable seam (for example a
`smthrs/cli-exec` helper that uses `node:child_process` under Node
and `Bun.$` under bun) before they are Node-importable. Until then they are
bun-test-only, which is fine: `bun test` runs all tiers.

The `smithersTest()` vitest plugin (`smthrs/testing/vitest`)
provides: esbuild `jsx: "automatic"` with `jsxImportSource: "smthrs"`
(matches the seeded tsconfig and per-file pragma), `@mdx-js/rollup` for `.mdx`
prompt imports (replacing the Bun-only `mdxPlugin()`), `resolve.dedupe:
["react"]` (the one-React rule the delegation shim enforces), and the `~/*` pack
alias.

### 7. CLI: `smithers test` and `smithers simulate`

- `smithers test [pattern]` runs the pack's tests
  (`.smithers/tests/**/*.test.{ts,tsx}`) under `bun test` with the MDX preload
  already seeded in `.smithers/bunfig.toml`. It composes with `smithers eval`
  (evals are model-graded and cost tokens; tests are deterministic and free); it
  does not duplicate it.
- `smithers simulate <workflow>` runs the simulation tier with `auto` for every
  agent task and stub values for non-pure compute (so it stays sub-second and
  spawns no subprocess), approvals auto-approved, loops capped. It prints the
  executed-task trace, the render budget, assertion results, and any
  deadlock or schema-mismatch findings. This is the "will this workflow
  structurally complete before I spend a token" check. We name it `simulate`,
  not `--dry-run`, because `--dry-run` on `eval`/`supervise` already means "plan
  without acting" (zero side effects), and because seeded workflows already take
  a userland `dryRun` input (release-content and others), so
  `up release-content --dry-run` would be ambiguous.
- `smithers init` seeds `.smithers/tests/` with focused tests for the curated
  workflow pack plus a `test` script in the pack `package.json`. This extends
  `renderPackageJson`/`templateFiles` in `apps/cli/src/workflow-pack.js` and
  regenerates the seeded pack (`scripts/generate-workflow-pack.ts` to
  `apps/cli/src/seeded-workflow-pack.generated.js`, a drift-guarded artifact).

Caveat: the delegate-to-local-CLI shim means `smithers test` and `smithers
simulate` are invisible in repos whose `.smithers/node_modules` pins an older
smithers, the same trap as the historical "Unknown command: migrate". Users bump
the pack-local install first.

## Relationship to the no-mocks policy (red lines)

`CLAUDE.md` bans mocks in product code and e2e. This library is a unit and
simulation layer; it mocks the agent, the single nondeterministic boundary, and
runs everything else real (real driver, real scheduler, real render, real compute
fns, real engine in tier 3). It matches the already-accepted pattern (inline
`{ generate }` stubs in engine tests, fake CLI binaries in CI). Explicit red
lines the issue and any review must hold:

1. Every seeded workflow keeps its fake-binary e2e. `seeded-workflows-run` stays
   a required CI gate. The 34-workflow simulation smoke complements it and can
   never replace it.
2. Nothing under `packages/testing` may be imported by product code. Mocks live
   only in the published testing subpath and in tests.
3. Simulation results are never reported as e2e results.

Proposed one-paragraph amendment to the `CLAUDE.md` "No mocks" section codifying
this sanctioned agent-boundary mock tier, so the boundary is policy rather than
one issue's promise.

## First test targets

Chosen for coverage of distinct engine features, trivial to complex. Node
importability noted because it decides vitest vs bun-only.

1. `hello` (Node-importable once `define` lands): one agent task plus an
   `outputMaybe`-gated output task; input null-arrival defaults; structured-output
   validation; run-output convention. Harness bring-up.
2. `ralph` (Node-importable): minimal `<Loop until={false} maxIterations={Infinity}>`;
   iteration semantics, `maxIterations` override, the simulation iteration cap,
   cancellation.
3. `plan` and `review` (Node-importable): Parallel panel plus moderator synthesis
   with `continueOnFail` panelists; glob/agent-identity mock routing; set vs
   subsequence execution assertions.
4. `triage-run` (bun-only: imports `bun`): deterministic CLI shell-out compute plus
   two chained agent tasks; the `targetRunId` fixture pattern (run `hello`, point
   `triage-run` at it); compute-mock for the shell-out; the `parseFirstJsonObject`
   CTA gotcha. Engine tier or bun-test sim.
5. `monitor` (bun-only): `<Branch>`-wrapped `<Approval onDeny="continue">` that
   activates only when `autofix && requireApproval && diagnosis unhealthy &&
   selfFixable`; gate-absent, approved, and denied paths; `Bun.write` artifact
   assertions at the engine tier; heartbeat timeouts.
6. `implement` (ValidationLoop): loop-until with a derived `done` from two sources
   (validate verdict plus review-moderator gate), cross-iteration feedback
   threading. One suite covers the composite reused by `improve-test-coverage`,
   `debug`, `kanban`, `research-plan-implement`.

Plus two suite-level gates:

- Simulation smoke for all 34 manifest workflows
  (`workflowManifestIds({ includeSystem: true })`) under `bun test`: every seeded
  workflow simulates to `finished` (or a declared waiting state) with `auto` and
  compute stubs. Strictly stronger than the existing `seeded-workflows-graph`
  render smoke, and far cheaper than `seeded-workflows-run` (both stay).
- `open-code-review` (authored, backs apps/review) as the first non-seeded
  adopter, via its existing `createOpenCodeReviewWorkflow(reviewAgents)` factory.

## Milestones (file as an epic, one sub-issue each)

Docs-driven: each milestone lands its docs first (they define the contract), then
code and tests. Ordered so the two highest-leverage deliverables (simulation and
the 34-workflow smoke plus CLI) land before the engine changes and the assertion
primitives.

| M | Contents | Verify |
|---|---|---|
| M1 core | `packages/testing` scaffold (source-shipping TS, root workspace dep, `package-configuration.mdx` row, explicit `./testing` export); `fakeAgent`/`auto`; `renderWorkflow`/`renderPrompt`/`runTask`; value matchers plus dual-runner d.ts augmentation | in-package bun tests; Node import-clean gate for the core |
| M2 simulation | `simulate()` handle; harness-owned mock executor; strictness rules; stepwise waits via `onWait`/session; clock; input null-fill parity; `sim.task`/typed outputs; glob and agent-identity mock routing | port `task-deps`-style cases; `hello` + `ralph` + `plan`/`review` tests written with the library |
| M3 smoke + CLI | 34-workflow simulation smoke (bun test); `smithers simulate`; `smithers test`; init-pack test scaffolding + `test` script | `apps/cli` e2e via the existing temp-repo harness; note the delegate-shim staleness caveat |
| M4 engine tier | `RunOptions.resolveAgent` (threaded through `executeTaskBridgeEffect`); `testWorkflow`, `createTempWorkspace`, sync `run.diff()` + `toMatchFiles`; re-export e2e-helpers as `/testing/e2e` | `triage-run` (bun) + `monitor` + `implement` tests; sim-vs-engine parity test (same mocks, same outputs) |
| M5 assertions | `invariants` prop with per-kind retry semantics; `<Assert>` component; `_smithers_assertions` table + `insertAssertionResult`; `INVARIANT_FAILED`/`ASSERTION_FAILED`; sim-tier evaluation + matchers | components/engine tests including agent retry-feedback threading; additive-table sync check on existing user stores |
| M6 vitest | `smthrs/define` (barrel restructure + dynamic-import DB); portable CLI-shell seam so bun-coupled workflows become Node-importable; `smithersTest()` vitest plugin; migrate seeded pack imports | vitest-on-Node CI job running tiers 1 and 2 against the Node-importable seeded workflows |
| docs (each M) | `docs/guides/testing-workflows.mdx`, `docs/reference/testing.mdx`, `docs/cli/overview.mdx` command rows, package-configuration tables; `pnpm docs:llms` regen (4 output locations); update the `smithers` skill so agents author tests alongside workflows | `check:docs` / `check:llms` |

## Row-shape parity (a correctness risk to pin)

Simulation output snapshots attach `nodeId`/`iteration` and wrap non-object
outputs as `{ payload }`; engine reads strip auto-columns. The M4 sim-vs-engine
parity test pins this so assertions written against `sim.outputs` also hold
against `run.outputs`; the harness normalizes both to the stripped shape.

## Operational costs

- New CI jobs: a Node import-clean gate for the core, the 34-workflow simulation
  smoke (bun test), and eventually a vitest-on-Node job. Estimate runtimes when
  M3 lands.
- vitest enters the pnpm lockfile as a new devDependency. CI runs pnpm, not bun,
  so a missed `pnpm-lock` update reds every job.
- The `_smithers_assertions` table is additive to existing user stores; confirm
  schema sync creates it on first run against an older DB.
- The delegate-shim staleness caveat for `smithers test`/`smithers simulate` is
  real; flag it in the CLI help.

## Open questions

- Mock keying is by node-id string. Type-level keying (id literal types via
  codegen) is possible later; v1 relies on schema-typed values plus loud runtime
  checks.
- `resolveAgent` is a runtime hook, so it needs the same rigor as any RunOptions
  field: docs, type, and a guard so a bogus returned agent fails clearly.
- The `define` barrel restructure changes the recommended authoring import;
  decide whether to codemod the seeded pack in one pass or migrate incrementally.

## Out of scope (future work)

- Full engine-on-Node (pglite backend plus portable sleep) so tier 3 runs in
  stock vitest.
- Replay-based regression tests from production traces (`forkRun` + `resetNodes`
  against an edited workflow). The substrate exists (`packages/time-travel`); a
  `replayTest()` API can follow.
- Property-based input generation from workflow input schemas (a natural `auto`
  extension).
- Gateway/UI-level testing (covered by gateway-react's happy-dom harness).
