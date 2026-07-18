# XState integration: durable derived control state

Status: proposed, revision 2 (2026-07-18) — revised after an adversarial sol
(GPT-5.6) review returned NEEDS-REWORK on rev 1. Direction upheld; five
blockers accepted and folded in below. Rev 1's per-finding dispositions are in
the "Review response" section at the end.
Owner: will@tevm.tech

## Verdict

Ship XState as an **optional derived-state layer** over the existing durable
rows — not as a backend, not as a scheduler, and not as a persisted actor. The
machine's current state is **recomputed as a pure fold over durable output
rows** using XState v5's pure `initialTransition` / `transition` functions
(xstate ≥ 5.19, current 5.32.x). Nothing about the machine is persisted;
resume, fork, and (once a known core defect is fixed) rewind are correct
because the fold's inputs are exactly the rows those features restore.

Rev 2 change: v1 now includes a small set of **core prerequisites** (Phase 0)
— durable completion-order provenance, a typed row reader, and a tagged
wait-result — because the review showed the "zero core changes" version has
unsound ordering and signal/timeout semantics.

```tsx
import { setup } from "xstate";
import { useSmithersMachine, taskOutput, approvalDecided, eventReceived } from "smithers-orchestrator/xstate";

function Release() {
  const ctx = useCtx();
  const state = useSmithersMachine(releaseMachine, {
    id: "release",
    input: ctx.input,
    events: [
      taskOutput(researchSchema, { nodeId: "research" }, () => ({ type: "RESEARCH_DONE" })),
      approvalDecided(gateSchema, { nodeId: "gate" }, (d) => (d.approved ? { type: "APPROVED" } : { type: "REJECTED" })),
      eventReceived(reviseSchema, { nodeId: revisionListenerId }, (r) =>
        r.kind === "timeout" ? { type: "TIMEOUT" } : { type: "REVISE", feedback: r.payload.feedback }),
    ],
  });
  // revision counter lives in machine context; it versions task identity below
  const rev = state.context.revision;

  return (
    <Workflow name="release">
      {state.matches("researching") && (
        <Task id="research" output={researchSchema} agent={researcher}>
          Research {ctx.input.topic}
        </Task>
      )}
      {state.matches("awaitingApproval") && (
        <ApprovalGate id="gate" output={gateSchema} when={/* ... */} onDeny="continue" request={{ title: "Continue to drafting?" }} />
      )}
      {state.matches("drafting") && (
        <>
          {/* machine re-entry does NOT re-execute a completed (nodeId, iteration);
              identity is versioned from machine context instead */}
          <Task id={`draft-r${rev}`} output={draftSchema} agent={writer} deps={{ research: researchSchema }}>
            {(deps) => `Write a report from:\n${deps.research.findings}`}
          </Task>
          <WaitForEvent id={`revise-r${rev}`} event="REVISE" output={reviseSchema} timeoutMs={86_400_000} onTimeout="continue" async />
        </>
      )}
    </Workflow>
  );
}
```

External events are ordinary signals: `smithers signal <runId> REVISE --data
'{...}'` (delivered via the Gateway, which resumes the run; the local CLI
prints the resume hint). There is **no `send()`, no `onDone` prop, and no
actor**.

## Why not the "persist the actor snapshot" design

A prior exploration converged on `useSmithersMachine = useMachine + snapshot
persistence + onDone callbacks + imperative send()`. Each piece contradicts a
verified engine contract:

1. **Render purity.** "The render function is a pure function of `ctx`"
   (docs/how-it-works.mdx:111) — an architectural contract (not mechanically
   enforced) that the scheduler leans on: it re-renders rather than trusting a
   submitted graph when outputs change. A live actor mutated by imperative
   sends makes the graph a function of process memory, not rows.
2. **Resume.** Resume constructs a fresh renderer and re-renders from
   preloaded output rows (packages/driver/src/WorkflowDriver.js:379+); all
   hook state resets. A `useMachine` actor silently restarts at its initial
   state unless snapshot rows are persisted — and those rows then become a
   second source of truth that rewind/fork must separately manage.
3. **Time travel.** Rewind truncates rows after the target and re-renders
   forward (packages/time-travel/src/jumpToFrame.js); fork copies rows into a
   child run. Derived state follows automatically; persisted actor snapshots
   don't.
4. **No callback props.** `TaskProps` has no `onDone`/`onError`; arbitrary
   function props are not consumed by graph extraction (they survive only in
   `rawProps` and are ignored). Completion is observed by the next frame
   reading the output row.
5. **No imperative frame API.** Workflow code cannot force a durable engine
   frame; React-local re-renders cannot wake or resubmit the scheduler.
   Frames are produced by engine decisions (task completion, signal delivery,
   timer fire, iteration advance, stability/deadlock re-checks, hot reload —
   list illustrative, not exhaustive).
6. **Actor-restore hazards.** XState restarts invoked actors on snapshot
   restore (stately.ai/docs/persistence). The fold uses no actors.

## Design

### Package

- `packages/xstate` → `@smithers-orchestrator/xstate`, re-exported as the
  `smithers-orchestrator/xstate` subpath. `xstate` is a peerDependency
  `^5.19.0` plus devDependency for tests.
- Phase 0 core prerequisites (below) touch `db`/`driver`/`engine` read paths;
  the package itself stays a read-only consumer of the (extended) public
  surface.

### Phase 0 — core prerequisites

1. **Durable completion-order provenance (v1 prerequisite, was "v2").**
   Output-row availability gets a branch-aware, monotonically assigned
   completion sequence exposed to render. Raw `_smithers_events` seq is NOT
   usable (rewind appends `TimeTravelJumped` rather than truncating, and fork
   starts a new run); the sequence must be recorded on (or derivable for)
   each output row version so fork copies it and rewind's surviving row set
   remains consistently ordered. Design detail (row column vs node/attempt
   join) decided at implementation; requirement: same rows ⇒ same order, on
   every branch, in every process.
2. **`ctx.outputRows(output, { nodeId?, scope? })`** — a public typed reader
   returning `{ payload, nodeId, iteration, seq }[]` exactly once per row
   (current `ctx.outputs` exposes payload arrays without row identity, and
   table-name/schema-key aliases can double-count). New public surface ⇒
   check-docs.
3. **Tagged wait results.** `onTimeout: "continue"` currently writes raw
   `null` through normal output validation — it fails typed schemas and is
   indistinguishable from a legitimately null payload
   (engine deferred-state-bridge). Change the wait-result envelope to a
   tagged shape (`{ kind: "signal", payload } | { kind: "timeout" }`) so
   timeouts are first-class, typed machine events.
4. **Rewind spanning-attempt fix (pre-existing core defect, blocks the
   time-travel claim).** Rewind deletes attempts by
   `startedAtMs > targetFrame.createdAtMs` and outputs only for those
   attempts — a parallel task that started before the target but completed
   after it survives rewind although its output was absent from the target
   snapshot. This breaks snapshot-consistency for ALL ctx-derived state, not
   just machines. Fix: restore/diff the exact target snapshot's node/output
   set; add a parallel spanning-attempt regression test. File as its own
   issue; the integration depends on it only for exact rewind semantics.

### The fold

Each frame, `useSmithersMachine(machine, { id, input, events })`:

1. Collects events by evaluating each declared source via `ctx.outputRows`:
   - `taskOutput(output, { nodeId }, map)` — one event per row. Named
     deliberately: it means "a successful durable output row exists", not
     "the task completed" — failed attempts write no row, `continueOnFail`
     can end a task without one, `(nodeId, iteration)` writes are upserts,
     and completions recorded after unmount still produce rows that enter
     the fold. `map` may return an event, an array, or `null` (skip).
   - `approvalDecided(output, { nodeId }, map)` — decision rows (denials
     require `onDeny: "continue"` to persist a row).
   - `eventReceived(output, { nodeId }, map)` — tagged wait results from
     `<WaitForEvent>`/`<Signal>` (signal payloads and timeouts).
2. Orders them by **(completion seq, declaration index, mapped-event
   subindex)** — causal arrival order, with deterministic tiebreaks. This is
   a total order that is a pure function of rows on every branch.
3. Folds: `initialTransition(machine, input)`, then
   `transition(machine, snapshot, event)` per event (both return
   `[snapshot, actions]`; returned actions are discarded — see constraints;
   builtin `assign` applies inside `transition`). Events not accepted in the
   current state are discarded, matching live-actor semantics — and because
   ordering is causal-arrival, a discarded event stays discarded on every
   refold (no retroactive acceptance).
4. Returns the final `MachineSnapshot` — `state.matches()`, `state.can()`,
   `state.context`, `state.hasTag()` work as `@xstate/react` users expect.

Performance: refolding history each frame is O(N²) total across a run's
frames in the worst case. In-process, causal-seq ordering makes the event
list append-only, so a validated-prefix cache folds only new events per
frame; full refold happens on resume/rewind/edit or when the derived prefix
changes. CI includes a benchmark at 10k+ events on a representative
hierarchical machine, and the docs publish practical limits.

### External events, listeners, and re-entry (semantics, not vibes)

- **Listeners are not durable inboxes.** Signal delivery matches only
  currently-parked waiters; a later-mounted waiter matches only signals
  received after its attempt started, and each `(nodeId, iteration)` waiter
  is one-shot. v1 therefore defines: **a signal delivered while no matching
  listener is mounted is dropped** — documented, and defensible because a
  live XState actor also discards events its current state doesn't handle.
  A durable inbox/cursor (buffer-while-unmounted) is v2, if demanded.
- **Repeated events need fresh listener identity.** A stable `revise` id can
  receive exactly one REVISE ever. The pattern (shown in the example): keep a
  counter in machine context via `assign`, and mint listener/task ids from it
  (`revise-r${rev}`).
- **Machine re-entry never re-executes a completed Smithers task.** A
  transition back into `drafting` changes derived state only; a completed
  `(nodeId, iteration)` is never re-run ("a completed task is never
  re-executed", docs/how-it-works.mdx:197). Loops that redo work MUST version
  task identity from machine context (as above) — the docs page shows this
  as THE revision-loop pattern and warns against expecting actor-style
  re-entry semantics.

### Final states (derived-only semantics)

The machine's status never drives run termination. Four documented
differences from live actors: (1) Smithers can finish while the machine is
non-final (graph quiescent); (2) a machine final state does not cancel
in-flight tasks — stop rendering them instead; (3) `snapshot.output` is not
the run output; (4) a "failure-flavored" final state does not fail the run —
render a failing/empty graph or a reporting task if that's wanted.

### Machine and callback constraints (enforced + documented)

- Lint runs per machine identity (not first-render-only, so hot reload
  re-lints) and rejects: `invoke`, `spawn` (including `spawn` inside
  `assign` — any snapshot with children is rejected), `after`, `raise`,
  `enqueueActions`, `sendTo`, `emit`, stop/cancel actions, and custom
  entry/exit/transition actions. Exact builtin allowlist: `assign` (without
  spawn). No `allowNonAssignActions` escape hatch in v1 — silently-inert
  actions are worse than a hard error, especially for AI authors.
- Determinism contract covers **every** callback in the fold: event mappers,
  context initializers, guards, assigners, machine `output` functions,
  params. Pure, side-effect-free, no time/randomness, no input mutation.
  Exception behavior specified (a throwing mapper/guard fails the render
  with a typed error naming the machine and event). Crash/resume conformance
  tests cover initial assign, eventless (always) transitions, nested
  `onDone`, guards, final output, post-final events.

### Mid-run edits

Resume rejects workflow-source mismatches unless `acceptWorkflowChange` is
explicitly enabled (engine warns determinism is then the caller's
responsibility). Machine edits ride the same gate — but because the fold
reinterprets history, the reducer definition as a whole (machine + mappers +
source declaration order + schemas) is hash-versioned; on change under
`acceptWorkflowChange`, the integration logs a machine-history
reinterpretation warning. Fork-and-migrate is the recommended path for
deliberate mid-run machine changes.

### Visualization / tooling

- **v1 (free):** machines are plain XState — Stately Studio import and
  `xstate/graph` static visualization work unmodified.
- **v1.5 (scoped honestly):** `smithers machine <runId>` reconstructs the
  state/event timeline **by refolding with the currently-loaded workflow
  code** — valid when the reducer hash matches the run. Server-side replay
  against the recorded workflow/VCS version, or a persisted
  machine-registry + canonical event envelopes, is v2; without it,
  history-from-any-client is not claimed.
- **v2:** optional `@statelyai/inspect` bridge over the Gateway WS.

## Docs plan

1. `docs/integrations/xstate.mdx` + `docs.json` nav + `INTEGRATIONS_PAGES`
   in `scripts/generate-llms.ts`; `pnpm docs:llms`; gated by
   check-docs/check-llms (Phase 0's `ctx.outputRows` is public surface —
   same gates). Page includes: when to use vs plain conditionals; the
   derived-not-persisted model; the constraints table; listener/re-entry
   semantics (the revision-loop pattern); final-state differences;
   time-travel semantics; visualization; the full compiled example.
2. Positioning per `why-react.mdx`: optional typed control state *inside*
   the React model, leaning on the agent-experience argument
   (`useSmithersMachine` deliberately mirrors `useMachine`/`state.matches()`).
3. Docs corrections bundled: "`useState` … reset on every render frame"
   (how-it-works.mdx:139/:344) → "process-local: survives frames within one
   process, lost on resume — never durable."
4. `docs/guides/common-footguns.mdx` cross-link.
5. The example ships as a **compiled, real-backend e2e fixture** (rev 1's
   inline example had type errors: ApprovalGate `output`/`when`/`onDeny`,
   `deps` vs `needs`, `--data` flag).

## Implementation plan

- **Phase 0 — core prerequisites (~2–3 days).** Completion-seq provenance,
  `ctx.outputRows`, tagged wait results, rewind spanning-attempt fix (+
  regression test). Each is independently valuable; land separately.
- **Phase 1 — the package (~2–3 days).** Fold + prefix cache, source
  helpers, lint, conformance/durability tests (crash/resume identity;
  rewind; fork; real signal e2e; benchmark). Both lockfiles in one commit.
- **Phase 2 — docs + example (~1 day).** As above; check-docs before
  landing.
- **Phase 3 — observability (~1–2 days, decoupled).** `smithers machine`
  (reducer-hash-scoped), gateway-ui panel.
- **Phase 4 (v2).** Durable signal inbox; machine registry + server-side
  historical replay; inspector bridge; `useDurableReducer` extraction if
  demanded.

Revised total for a shippable v1: **roughly 6–9 focused days** (rev 1 said
3–4; the review moved ordering, timeout, and row-identity work from "v2 /
free" into v1 and added the rewind fix).

## Independent defects surfaced by review (file regardless of this design)

1. Rewind spanning-attempt output survival (jumpToFrame.js attempt-window
   deletion) — snapshot-inconsistency for all derived state.
2. `onTimeout: "continue"` writes raw `null` through typed output
   validation — unusable with typed schemas, ambiguous with null payloads.
3. Facade types: `packages/smithers/src/index.d.ts` exposes
   `TaskProps = any` despite the real component type.

## Explicit non-goals

- `backend: "xstate"` or any storage replacement.
- XState as scheduler, or `sx.task()` actors that execute work.
- `onDone`/`onError` callback props on `<Task>`.
- Persisting actor snapshots as truth, or imperative `send()` from workflow
  code. Human/UI interaction stays on durable channels: signals, approvals,
  `ask-human`.

## Review response (sol, 2026-07-18, rev 1 → rev 2)

Verdict was NEEDS-REWORK; all five blockers accepted. Dispositions:
1 (ordering not causal; retroactive acceptance) — ACCEPTED; completion-seq
ordering promoted to v1 prerequisite. 2 (rewind deletion incomplete; events
not truncated) — ACCEPTED; core defect filed; v2-ordering-via-events claim
withdrawn. 3 (listeners aren't durable inboxes; one-shot waiters) —
ACCEPTED with nuance: drop-while-unmounted is actor-consistent and becomes
the documented v1 semantic; iteration-versioned listener identity is the
repeated-event pattern; durable inbox deferred. 4 (timeout null untyped/
ambiguous) — ACCEPTED; tagged wait results in Phase 0. 5 (re-entry doesn't
re-execute tasks) — ACCEPTED; context-versioned identity is the documented
pattern. 6 (helper signatures/row identity) — ACCEPTED; `ctx.outputRows` +
output-target-first signatures. 7 (final states) — ACCEPTED; derived-only +
four differences documented. 8 (determinism beyond guards) — ACCEPTED.
9 (lint allowlist, spawn-in-assign, re-lint, drop escape hatch) — ACCEPTED.
10 (taskOutput rename + upsert/stale semantics) — ACCEPTED. 11 (example
doesn't typecheck; CLI flag) — ACCEPTED; example becomes compiled e2e
fixture. 12 (edits gated by acceptWorkflowChange; version whole reducer) —
ACCEPTED. 13 (O(N²); benchmark; prefix cache) — ACCEPTED; seq ordering makes
the prefix cache sound. 14 (viz needs machine registry) — ACCEPTED; v1.5
scoped to reducer-hash-matched reconstruction. 15 (prop-stripping wording;
TaskProps=any) — ACCEPTED; wording fixed, defect filed. 16 (purity is
contract; trigger list illustrative) — ACCEPTED. 17 (initialTransition
signature; conformance tests) — ACCEPTED.
