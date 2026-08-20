# Flows migration: replace the Smithers runtime with the flows library

> Program spec. Consumed by `.smithers/workflows/flows-migration.tsx`.
> Two trees: `~/smithers` (this repo) and `~/flows/flows` (the flows library,
> git remote `smithersai/flows`, jj colocated, a submodule of
> `smithersai/monorepo`).

## Goal

Replace Smithers' hand-written engine with the flows durable-execution library,
incrementally, with both systems running side by side at every step. Three
product stages, plus a stage 0 of prerequisites that nothing else can land
without.

1. Stage 1: flows is the underlying engine.
2. Stage 2: the flows agent primitive replaces the Vercel AI SDK, and every
   first-class Smithers agent becomes a flows harness adapter.
3. Stage 3: flows is the public authoring API, with an optional `flows-react`
   that keeps React as the render loop and lets an agent decide each re-render.

## What flows already is

`~/flows/flows` is an Effect-based durable execution engine (Effect pinned to
exactly `4.0.0-rc.108`). It vendors Effect's workflow surface and diverges from
it: caller-chosen execution IDs, content-addressed step keys over canonical
JSON, immediate cancellation, opt-in retry of infrastructure interrupts.

Engine group: `@smthrs/{canonical,capability,crypto,keys,database,journal,
run-store,step-cache,artifacts,plan,flow,engine,engine-store,kernel,sync,
time-travel,jj,sandbox,platform-node,platform-bun,platform-browser,flows}`.

Agent group: `@smthrs/{core,harness,engine-harness,model,std,patterns,memory,
registry,control,gateway,evals,scorers,notifications,observability,plugin,
triggers,testing,fs,cli}`.

Load-bearing pieces for this program:

| Piece | Where | Replaces in Smithers |
| --- | --- | --- |
| `Action` / `Flow` / `Interpreter` | `packages/flow` | the JSX task model at the execution layer |
| `FlowEngine`, `EngineStore` | `packages/engine`, `packages/engine-store` | `packages/engine/src/engine.js` (12k lines) |
| Journal, RunStore, StepCache | `packages/journal`, `run-store`, `step-cache` | `packages/db/src/adapter.js` event/attempt/claim paths |
| Keyed action graph and diff | `packages/plan` | `packages/graph` + `packages/scheduler` plan tree |
| `Model.stream(request)` | `packages/model` | `ai` / `@ai-sdk/*` |
| `Harness.run(step, host)` | `packages/harness` | `AgentLike` in `packages/agents` |
| Cell loop (`CellTurn`, `CellHarness`) | `packages/harness`, `packages/engine-harness` | the in-process AI SDK agent loop |
| Standard tools | `packages/std` | ad-hoc tool wiring in `packages/agents` |
| Higher-order patterns | `packages/patterns` | `<Panel>`, `<Debate>`, `<ReviewLoop>`, `<Approval>` composites |
| `NodeRuntime` | `packages/flows` | `createWorkflowSession` storage wiring |

flows' own gap analysis is authoritative on engine readiness:
`~/flows/flows/docs/architecture/smithers-replacement-gaps.md`. Of nine audit
areas, five are closed (waiting taxonomy, owner liveness, journal fencing,
fault harness, supervisor sweep), three are partial with the hard half done
(control verbs, lineage, quota park), and one is missing (host checkpoints and
worktree lanes).

## Stage 0: prerequisites

Nothing in stages 1 to 3 can land until these do.

### 0.1 Package names: flows keeps them, smithers yields (decided)

flows publishes seven package names Smithers already owns on npm at 0.35.0:
`@smthrs/engine`, `@smthrs/gateway`, `@smthrs/memory`, `@smthrs/sandbox`,
`@smthrs/scorers`, `@smthrs/testing`, `@smthrs/time-travel`.

This is deliberate, not an oversight. flows commit `84fd9eb5bd29`
("drop the -next suffix from every package name", 2026-08-18) took the bare
names on the stated grounds that "flows is the tree now". No rename lane is
planned. The decision stands.

The collision is a naming question, not an install blocker. Measured, not
assumed: a pnpm workspace that contains a package named `@smthrs/engine` and
also depends on the registry's `@smthrs/engine` installs both. The workspace
copy wins the bare specifier, and the registry copy is reachable under an
alias, isolated in `.pnpm`. Since pnpm 10, a workspace package is linked only
where a dependency uses the `workspace:` protocol, and every internal Smithers
dependency does.

The interim rules that follow from that:

- flows publishes `0.1.0-alpha.N` under the `alpha` dist-tag, never `latest`,
  so `@smthrs/engine@latest` keeps resolving to Smithers 0.35.0 for existing
  users through the whole transition.
- Smithers consumes flows through `@smthrs/flows`, the umbrella barrel, which
  collides with nothing. Its transitive engine packages resolve inside `.pnpm`
  under their real names and never touch the workspace's own name resolution.
- Where a bare-name flows package must be imported directly, Smithers declares
  it as an alias, `"@flows/engine": "npm:@smthrs/engine@<alpha>"`, so the
  import specifier in Smithers source is unambiguous to a human and to
  TypeScript.

At cutover the collision dissolves on its own: the seven colliding Smithers
packages are exactly the ones flows replaces. They become `private: true`, or
are deleted, as stages 1 and 2 subsume them, and flows publishes a major that
takes the `latest` tag.

### 0.2 Alpha publish train

Complete `~/flows/flows/HUMAN-TASKS.md` H1 to H4 and publish `0.1.0-alpha.N`
from CI, so Smithers consumes real versions instead of path links. Until the
first publish, Smithers may use a local `link:` overlay for development only;
CI must install the published alpha. Gate: a scratch package installs the alpha
from the registry and runs the flows quick-start program.

### 0.2a Vendored flows, until the alpha publishes (LANDED)

H1 to H4 are owner-only and not done, so there is no published alpha to depend
on. The interim, on the stage-0 base as `ba5331f7`, is a vendored closure:

- `scripts/vendor-flows.mjs` packs the flows packages from a sibling checkout
  into `vendor/flows/` as tarballs, committed so a frozen install works for
  everyone rather than only on the machine that has a flows checkout.
- A private workspace package at `vendor/flows/` aliases each tarball under
  `@flows/*`. **Import flows as `@flows/flow`, `@flows/plan`, `@flows/engine`,
  and so on. Never import the bare `@smthrs/flow`**: the bare names belong to
  this workspace.
- The root `pnpm.overrides` are keyed by name *and version*
  (`"@smthrs/engine@0.1.0"`), so they capture only the flows copies and never
  this workspace's own package of the same name.
- `vendor/flows/resolution.test.mjs` pins the rule: nine `@smthrs` names exist
  in both trees, the bare name always resolves here, and the flows copy is only
  reachable under its alias. It also runs the flows quick start in-process, so
  the vendored engine is proven to execute, not merely install.
- `vendor/flows/README.md` documents the swap that deletes the directory once
  the alpha publishes.

### 0.3 Effect substrate bump

Smithers pins `effect@4.0.0-beta.105` in at least ten manifests
(`packages/{memory,driver,scheduler,agents,server,scorers,openapi,integrations,
testing,components}`). flows pins exactly `4.0.0-rc.108`. Two Effect majors in
one process is not viable, so Smithers moves to rc.108 first.

The fallout lands in `packages/engine/src/effect/*`, which bridges Smithers to
`effect/unstable/workflow` and `effect/unstable/cluster` (activity bridge,
compute-task bridge, deferred-state bridge, entity worker, single runner,
builder, RPC schema). Gate: `pnpm typecheck`, `pnpm test`, and the engine
effect-bridge internals tests.

### 0.4 SQL dialect decision

flows ships one SQL backend: SQLite over `@effect/sql-sqlite-node`, and every
migration set is SQLite-flavoured DDL. Smithers supports PGlite and Postgres
(`packages/db/src/dialect.js`, `packages/db/src/ensure.js`, `smithers migrate`).

Decision: stage 1 ships default-off and refuses to enable on a non-SQLite
workspace. Before stage 1 flips default-on, flows lands the three steps written
in its gap analysis: `packages/database/src/pg` and `src/pglite` layers, a
dialect parameter on `Migrations.run` plus the out-of-ladder DDL inventoried in
`packages/engine-store/src/internal/EngineStateSchema.ts` (the
`flows_run_parents_gc` trigger is the blocker), and the journal and engine-store
suites run against PGlite as a second CI backend.

### 0.5 Parity harness

A cross-engine conformance suite in Smithers (`e2e/parity`): a fixture set of
workflows runs on the legacy engine and on flows, asserting identical node
states, output rows, event projections, and terminal verdicts. The fault cases
in `e2e/faults` are ported into it. This suite is the objective gate for every
later lane; no lane in stages 1 to 3 is accepted while it is red.

## Stage 1: flows as the underlying engine

Ordered as flows recommends: storage first, loop second, control third, time
travel last. Everything is behind `SMITHERS_ENGINE=flows` until 1.7.

### 1.1 Storage swap behind an adapter-compat module

Replace `packages/db/src/adapter.js`'s `insertEventWithNextSeq`,
`claimRunForResume`, and the attempt tables with the flows Journal, RunStore,
and AttemptStore, behind a module that preserves adapter.js's call signatures.
flows is strictly stronger here: fenced run-scoped writes, sequence allocation
inside the write transaction, lease-based stale-owner steal, no pid probing.
Needs an event-shape translator (Smithers event rows to journal producer
events) and a one-shot migration for live runs. Gate: the db and engine suites,
plus the parity harness on SQLite.

### 1.2 Graph to Plan compiler

New package `packages/flows-compile`: `GraphSnapshot` from `@smthrs/graph`'s
`extractGraph` compiles to a `@smthrs/plan` keyed action graph plus
`@smthrs/flow` definitions.

- Agent task becomes a harness `AgentStep` action.
- Compute task becomes an action whose body runs the `computeFn`.
- Static task becomes a sealed constant step.
- `dependsOn` / `needs` / `deps` become plan edges; the plan derives the rest
  from content.
- Smithers node IDs are carried as annotations so the gateway, UI, and CLI keep
  addressing nodes by the IDs they already show, while step identity is the
  flows content hash.

Gate: golden plan snapshots for the fixture workflows, plus parity.

### 1.3 Dual-engine routing

`createWorkflowSession` takes an engine selector. New runs execute on
`FlowEngine` plus `DurableEngineState`; runs already in flight finish on the
legacy loop. Storage and engine wiring comes from `@smthrs/flows/NodeRuntime`;
Smithers supplies host services, the capability kernel, and the
registration-before-resume guarantee through that layer's `registerFlows`
phase. Gate: parity harness on both engines in CI, and a restart test that
resumes a flows run after process death.

### 1.4 Waiting taxonomy and RunControl

Approvals, timers, events, and quota parks route through
`FlowRuntime.annotateWaiting` with `{ reason, wakeAt?, token? }` instead of
engine.js's inline waiting states. Land flows' `RunControl` (pause and cancel
with actor and reason attribution, journaled), and make `smithers pause`,
`cancel`, and `steer` thin calls onto it. Delete `apps/cli/src/supervisor.js`'s
claim-by-proxy process: the flows run driver sweeps stale-running rows,
released rows, and due wakes on its own heartbeat. Gate: the restart-waiting
fault cases, plus a pause and a hijack case with attribution asserted.

### 1.5 Injected classifiers

Provider quota and transient error classification stays in Smithers as an
injected service at the wait/wake seam (`classifyError`, `resolveRetry`), so
the hard-won provider quirks never move into the executor. Quota errors park
with a `wakeAt` and wake through the durable clock. Gate: one park-then-wake
fault case per provider family.

### 1.6 Checkpoints and time travel

The largest missing surface. A layer-gated `Checkpoint` host capability
(no-op in the browser) snapshots agent-session and worktree state at step
boundaries under an injected trigger policy. `snapshot-hook`, `restore`,
`revert`, `rewind`, and the `smithers worktree` lanes move onto it and onto the
flows time-travel stores. Gate: the existing time-travel CLI suites, run
against the flows engine.

### 1.7 Default-on, then delete

Flip the default to flows, keep the legacy loop behind a flag for one release,
then delete the subsumed internals in `packages/scheduler` and
`packages/driver`. Gate: a full green `pnpm test`, `pnpm -C e2e test`, and the
parity harness with the legacy engine as the fixture oracle.

## Stage 2: the agent primitive replaces the Vercel AI SDK

### 2.1 Model seam

Adopt `@smthrs/model` as the one provider seam: `Model.stream(request)` returns
a stream of `ModelEvent`, cancellation is fiber interruption. Anthropic
Messages, OpenAI Responses, and the OpenAI-compatible protocol already ship
there, along with auth, framing, routing, and tool streaming. Remove `ai` and
`@ai-sdk/*` from `packages/{engine,agents,tool-context,openapi,agent-eliza}`
and `apps/smithers`. Gate: the agent suites, plus a live smoke call per
provider family.

### 2.2 Harness contract

`Harness.run(step, host)` returns a stream of `AgentEvent`. Map Smithers'
`AgentLike` onto it with a bidirectional adapter so existing workflows and
third-party agents keep working unchanged during the port. Gate: the adapter
round-trips every event kind, proven by the agent contract tests.

### 2.3 Port every first-class agent

One lane per adapter, each gated by that agent's existing tests:
ClaudeCode, Codex, Gemini, OpenCode, Amp, Cursor, Grok, Kimi, Hermes,
HermesCli, Antigravity, Omp, OpenClaw, Pi, Nanocodex, Forge, Anthropic,
OpenAI, plus `PoolAgent` and `fallbackAgents` (the seat pool must keep working
verbatim: nine seats, `seed: ctx.runId`).

### 2.4 Cell loop as the built-in agent

The cell path (`CellTurn` composed by `@smthrs/engine-harness/CellHarness`)
becomes the in-process agent, replacing the AI SDK loop in `packages/agents`.
Tools come from `@smthrs/std` (Read, Write, Edit, Bash, Grep, Glob, Ls,
ApplyPatch, WebFetch, WebSearch, LSP), with Smithers' MCP toolsets and
document-parsing tools bridged as flow tools. Gate: an agent task that edits
files, runs a command, and reports structured output, on the cell loop only.

### 2.5 Usage, tokens, and scorers

`smithers usage`, quota routing, and the scorers read `@smthrs/model` events
instead of AI SDK usage objects. Gate: `smithers usage --run` totals match the
legacy numbers on a replayed fixture run.

## Stage 3: flows becomes the API

### 3.1 Promote the flows authoring API

`@smthrs/flows` becomes the documented way to write a workflow: `Action`,
`Flow`, `Interpreter`, the `@smthrs/core` node builders, and `@smthrs/patterns`
for the higher-order shapes (`Debate`, `Panel`, `MapReduce`, `ReviewLoop`,
`Escalation`, `Recursion`, `WithApproval`, `WithCache`, `WithRetry`), which
already mirror the Smithers composites.

### 3.2 flows-react

React stays as a render loop, but only as a driver. The seam is already
specified in `.smithers/specs/effect-react-library.md` and
`.smithers/specs/effect-react-integration.md`; the core in those documents is
now flows. React renders JSX, the reconciler builds the host tree,
`extractGraph` produces a graph, the stage 1.2 compiler turns it into a plan,
the engine executes it, outputs land, and the render loop runs again.
`packages/flows-compile` is promoted to the public `flows-react` package.

### 3.3 Agent-decided re-render

The continuation of each render loop is chosen by an agent rather than by a
fixed `until` and `maxIterations`. `@smthrs/harness` already translates a
dynamic node into sealed model steps and child plans (`Elaborate`, `Plan`,
`Cell`); `flows-react` exposes that as the loop driver, so each pass decides
what the next graph should be. Smithers already approximates this with the
monitor narrator and `<Trellis>`; this generalizes it and makes it the default
loop rather than a composite.

### 3.4 Compatibility layer

The current JSX surface (`<Task>`, `<Sequence>`, `<Parallel>`, `<Loop>`,
`<Branch>`, `<Approval>`, `<Worktree>`, `<Subflow>`, and the rest) ships as
`flows-react/compat` so the roughly 200 workflows in `.smithers/workflows` keep
running. A codemod moves the shipped pack. Gate: `pnpm -C .smithers` workflow
tests plus a graph render of every pack workflow on both APIs.

### 3.5 Docs and bundles

`docs/` is rewritten around the flows API, `pnpm docs:llms` regenerates the
bundles, and `check-docs` and `check-llms` gate the result. The Smithers JSX
pages move to a compatibility section.

## Acceptance

The program is done when:

1. `SMITHERS_ENGINE` no longer exists because there is one engine.
2. `packages/{scheduler,driver}` and the bulk of `packages/engine/src/engine.js`
   are deleted, and the parity harness passes with recorded legacy fixtures.
3. No manifest in this repo depends on `ai` or `@ai-sdk/*`.
4. Every first-class agent runs as a flows harness adapter, with its existing
   tests green.
5. `flows-react` renders and executes every workflow in `.smithers/workflows`.
6. The docs bundles describe the flows API, and `check-docs` and `check-llms`
   pass.

## Rules for every lane

- Work in the lane's own jj workspace, never in a shared checkout.
- One jj change per lane, `<emoji> <type>(<scope>): <subject>`.
- Never edit the other stage's files; scopes are declared per lane.
- Dependency changes refresh both `pnpm-lock.yaml` and `bun.lock`.
- Product code and E2E tests use real backends, never mocks.
- A lane that cannot finish reports `blocked` with the reason. It does not
  widen its scope.
