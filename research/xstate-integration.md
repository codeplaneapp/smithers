# XState integration: durable derived control state

> **Written for Smithers 0.x.** This note is research from before the 1.0
> rewrite. It describes the JSX workflow runtime, its CLI, or its gateway, none
> of which exist in 1.0.0-rc.0. It is kept as history, not as guidance; see
> `docs/pages/migration/1.0.md` for what replaced each surface it names.

Status: revision 3 (2026-07-18) — rev 1 reviewed by sol (NEEDS-REWORK, all
findings folded into rev 2); rev 2 + the landed Phase 0 implementation
reviewed by a Fable subagent (APPROVE-WITH-CHANGES, all findings folded in
here). Phase 0 is implemented; Phase 1 not yet started. Per-finding
dispositions for both reviews are in the "Review response" sections at the end.
Owner: will@tevm.tech

## Verdict

Ship XState as an **optional derived-state layer** over the existing durable
rows — not as a backend, not as a scheduler, and not as a persisted actor. The
machine's current state is **recomputed as a pure fold over durable output
rows** using XState v5's pure `initialTransition` / `transition` functions
(peer range `^5.19.0`; pin the concrete version in Phase 1's lockfile).
Nothing about the machine is persisted;
resume, fork, and (once a known core defect is fixed) rewind are correct
because the fold's inputs are exactly the rows those features restore.

Rev 2 change: v1 now includes a small set of **core prerequisites** (Phase 0)
— durable completion-order provenance, a typed row reader, and a tagged
wait-result — because the review showed the "zero core changes" version has
unsound ordering and signal/timeout semantics.

```tsx
import { setup } from "xstate";
import { useSmithersMachine, taskOutput, approvalDecided, eventReceived, timedOut } from "smthrs/xstate";

function Release() {
  const ctx = useCtx();
  // Event sources are pure functions of ctx — never of machine state.
  const state = useSmithersMachine(releaseMachine, {
    id: "release",
    input: ctx.input,
    events: [
      taskOutput(researchSchema, { nodeId: "research" }, () => ({ type: "RESEARCH_DONE" })),
      approvalDecided(gateSchema, { nodeId: "gate" }, (d) => (d.approved ? { type: "APPROVED" } : { type: "REJECTED" })),
      eventReceived("REVISE", reviseSchema, (p) => ({ type: "REVISE", feedback: p.feedback })),
      timedOut(reviseWaitSchema, { scope: "revise" }, () => ({ type: "TIMEOUT" })),
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
          {/* Wake-and-park plumbing: keeps the run alive while awaiting REVISE and
              wakes a frame on delivery. The machine's REVISE events come from the
              durable signal table, not from this node's output. */}
          <WaitForEvent id={`revise-r${rev}`} event="REVISE" output={reviseWaitSchema} timeoutMs={86_400_000} onTimeout="continue" async />
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

- `packages/xstate` → `@smthrs/xstate`, re-exported as the
  `smthrs/xstate` subpath. `xstate` is a peerDependency
  `^5.19.0` plus devDependency for tests.
- Phase 0 core prerequisites (below) touch `db`/`driver`/`engine` read paths;
  the package itself stays a read-only consumer of the (extended) public
  surface.

### Phase 0 — core prerequisites

1. **Durable completion-order provenance (v1 prerequisite, was "v2").**
   Output-row availability gets a branch-aware, monotonically assigned
   completion sequence exposed to render. Raw `_smithers_events` seq is NOT
   usable (rewind appends `TimeTravelJumped` rather than truncating, and fork
   starts a new run); the sequence must be recorded so fork copies it and
   rewind's surviving row set remains consistently ordered. Requirement: same
   rows ⇒ same order, on every branch, in every process — and "in every
   process" means every persistence path that carries rows to a render
   (engine snapshot load, incremental frame cache, driver-storage
   `saveOutputs`/`loadOutputs` round-trips) must carry seq intact; a
   non-enumerable symbol dropped by JSON round-trips or object spreads does
   not satisfy this.

   **Chosen design:** a dedicated `_smithers_output_provenance` row per
   `(runId, outputTable, nodeId, iteration)`. The first successful upsert
   allocates the next run-local sequence; a later upsert of the same key
   retains its original sequence — positions never reorder. Allocation and
   output upsert commit together, so crash/resume sees neither or both.
   Forks copy provenance rows before allocating new child completions;
   rewind filters them to the target snapshot's row set. Rejected options:
   a user-visible column in every output schema (leaks runtime bookkeeping
   into user tables) and a node/attempt join (never viable — fork copies
   neither attempts nor per-node timing, and snapshot hydration stamps every
   restored node with one shared `restoredAtMs`).

   **Legacy rows:** pre-upgrade runs have output rows with no provenance.
   The migration must backfill deterministically (by rowid within each
   table's key order) and must resolve schema-key vs physical-table naming
   when it does; rows that still lack seq after backfill are excluded from
   `ctx.outputRows` with a surfaced warning, never silently.

   **Signals join the same clock (added rev 3):** signal ingestion allocates
   from the same run-local sequence space, so machine folds can merge signal
   events and output events on one total order. Rewind filters signal
   provenance to the same horizon as outputs.
2. **`ctx.outputRows(output, { nodeId?, scope? })`** — a public typed reader
   returning `{ payload, nodeId, iteration, seq }[]` exactly once per row.
   `ctx.outputs` already exposes full raw rows (including nodeId/iteration);
   the reader exists for dedup (table-name/schema-key aliases double-count),
   durable completion order, and typed payload separation. It must resolve
   real Drizzle output targets (table names live under
   `Symbol(drizzle:Name)`, not `.name`) and must never fall back to an
   enumerable `seq` field in user payloads as if it were provenance. New
   public surface ⇒ check-docs, and the emitted driver `.d.ts` must be
   consumer-tested (the generic-alias emit is a known tsup trap).
3. **Tagged wait results.** `onTimeout: "continue"` currently writes raw
   `null` through normal output validation — it fails typed schemas and is
   indistinguishable from a legitimately null payload
   (engine deferred-state-bridge). Change the wait-result envelope to a
   tagged shape (`{ kind: "signal", payload } | { kind: "timeout" }`) so
   timeouts are first-class, typed machine events.

   **Compatibility contract (rev 3, hardened after review):** envelope
   selection must be EXPLICIT, not sniffed and not try-tagged-then-fallback.
   Review probes showed both failure modes: a schema that coincidentally
   declares `kind`+`payload` silently receives the envelope, and an
   envelope-first-with-fallback write can corrupt permissive legacy schemas
   (an optional field accepted the envelope shape and persisted `null`
   instead of the signaled payload). The selection mechanism is an explicit
   opt-in (e.g. a `waitResult(schema)` wrapper or component flag) — schemas
   not opted in keep the raw legacy payload; `onTimeout: "continue"` on a
   non-opted-in typed schema is a hard, well-named error rather than a
   silent null row. The break vs old behavior (legacy `continue` used to
   write a null row) is documented in the changelog and the WaitForEvent
   docs.
4. **Rewind spanning-attempt fix (pre-existing core defect, issue #1351).**
   Rewind deletes attempts by `startedAtMs > targetFrame.createdAtMs` and
   outputs only for those attempts — a parallel task that started before the
   target but completed after it survives rewind although its output was
   absent from the target snapshot. This breaks snapshot-consistency for ALL
   ctx-derived state, not just machines. Fix: restore the exact target
   snapshot's node/attempt/output set. Constraints learned in
   implementation review (rev 3): the legacy `resetNodesToPending` pass must
   NOT run after exact-snapshot restore (it stomps restored finished nodes
   that have post-target attempts back to pending — confirmed by repro);
   provenance filtering and row restore must land together (filtering alone
   would strand rows visible to `ctx.outputs` but invisible to
   `ctx.outputRows`); provenance cleanup failures must not be swallowed
   (a stale surviving seq can be reused and reorder a new branch); and the
   no-target-snapshot fallback must be explicit — fail loudly or document
   legacy-heuristic behavior, never silently degrade. Regression tests must
   include the retried-after-rewind-point case (finished on attempt 1
   pre-target, retried post-target, rewound ⇒ finished/lastAttempt=1), not
   only the fully-deleted-node case.

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
   - `eventReceived(signalName, schema, map)` — **rev 3 design change:**
     folds directly over durable `_smithers_signals` rows (which share the
     provenance clock per Phase 0 item 1), NOT over `<WaitForEvent>` output
     rows. Signal rows are already durable and ordered; reading them
     directly makes every delivered signal visible to the fold regardless
     of listener mount timing, eliminating the one-shot-listener loss and
     delivery races entirely. `timedOut(output, { nodeId }, map)` reads
     tagged timeout rows from opted-in waits.
   - **Event-source declarations must be pure functions of `ctx` — never of
     machine state.** Deriving a source's nodeId from the fold's own output
     is circular and rejected.
2. Orders them by **(provenance seq, declaration index, mapped-event
   subindex)** — causal arrival order, with deterministic tiebreaks. This is
   a total order that is a pure function of rows on every branch.
3. Folds: `initialTransition(machine, input)`, then
   `transition(machine, snapshot, event)` per event (both return
   `[snapshot, actions]`; returned actions are discarded — see constraints;
   builtin `assign` applies inside `transition`). Events not accepted in the
   current state are discarded, matching live-actor semantics. Because
   ordering is causal-arrival, positions never reorder across refolds —
   with one carved-out exception: an in-place payload replacement at the
   same `(nodeId, iteration)` (manual `retry-task` of a completed node,
   HumanTask reopen) keeps its seq but changes its payload, so folded
   history from that position REINTERPRETS. This is documented; workflows
   feeding machines from replaceable tasks should prefer fork-and-migrate.
4. Returns the final `MachineSnapshot` — `state.matches()`, `state.can()`,
   `state.context`, `state.hasTag()` work as `@xstate/react` users expect.

Performance: refolding history each frame is O(N²) total across a run's
frames in the worst case. In-process the event list is append-only EXCEPT
for in-place payload replacement (above), so the validated-prefix cache
must validate by **content** (a payload hash per event), not by
`(count, maxSeq)` — a replacement that preserves both would otherwise serve
a stale snapshot for a frame. Full refold happens on resume/rewind/edit or
any prefix-content mismatch. CI includes a benchmark at 10k+ events on a
representative hierarchical machine, and the docs publish practical limits.

### External events, listeners, and re-entry (semantics, not vibes)

- **The signal table is the event source; listeners are wake-and-park
  plumbing (rev 3).** The earlier "drop-while-unmounted, actor-consistent"
  framing was wrong on both counts: waiters are one-shot per
  `(nodeId, iteration)`, delivery matches only currently-parked waiters, a
  replacement waiter matches only signals received AT OR AFTER its attempt
  start, concurrent deliveries race last-wins in memory vs first-by-seq on
  resume, and a signal in the gap between one generation's resolution and
  the next generation's attempt insert is lost — while a live actor in the
  same state would have processed all of them. Rather than document that
  loss, v1 removes it: `eventReceived` folds over `_smithers_signals`
  directly, so every delivered signal reaches the machine in seq order no
  matter when listeners were mounted. A parked `<WaitForEvent>` still
  matters for LIVENESS — an idle machine state with nothing rendered makes
  the graph quiescent and ends the run — so states awaiting external events
  render a listener to keep the run parked and to wake a new frame on
  delivery; a missed wake delays the fold by one frame but never loses the
  event.
- **Machine re-entry never re-executes a completed Smithers task — for ANY
  re-enterable state.** A transition back into a state changes derived
  state only; a completed `(nodeId, iteration)` is never re-run ("a
  completed task is never re-executed", docs/how-it-works.mdx:197). The
  general rule (docs page + lint): any task rendered inside a machine state
  that the machine can re-enter needs context-versioned identity
  (`draft-r${rev}` minted from an `assign` counter). A bare-constant task
  id in a state on a machine cycle deadlocks the machine (no new row ⇒ no
  new event ⇒ quiescent graph ends the run mid-flight); the lint flags it.
- **`id` option semantics:** `useSmithersMachine({ id })` namespaces the
  machine instance for error messages, caching, and the (v1.5)
  `smithers machine` timeline — multiple machines per workflow are
  supported and must use distinct ids.

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

- **Phase 0 — core prerequisites.** Completion-seq provenance,
  `ctx.outputRows`, tagged wait results, rewind spanning-attempt fix (+
  regression test). Each is independently valuable; land separately.
  **Status (2026-07-18):** first implementation pass complete on a local
  branch (one commit per item) but NOT pushed — final validation and the
  review moderator rejected it with a confirmed critical rewind regression
  and the correction backlog below. A superior rewind fix exists in the
  run's earlier unmerged lineage; the correction pass reconciles them.

### Phase 0 correction backlog (from validation + moderator + Fable review)

1. **CRITICAL — rewind:** remove the unconditional legacy
   `resetNodesToPending` pass after exact-snapshot restore (repro: finished
   pre-target on attempt 1, retried post-target, rewound ⇒ stomped to
   pending). Prefer the fix already written in the unmerged lineage
   (8bc9c18da6..6350d630d8). Add the retried-after-rewind-point regression.
2. **CRITICAL — `ctx.outputRows` unusable in practice:** resolve Drizzle
   targets via `Symbol(drizzle:Name)`; carry provenance seq through every
   row path (the non-enumerable symbol is dropped by
   `coerceBooleanColumns`'s spread and by driver-storage JSON round-trips —
   carry it as real data, not a symbol); never treat an enumerable user
   `seq` field as provenance; consumer-test the emitted driver `.d.ts`
   (current emit has a non-generic `OutputRowsReader` applied as generic,
   TS2315).
3. **MAJOR — legacy backfill:** migration 0030 must actually run (table
   pre-creation currently marks it applied), resolve schema-key vs physical
   table names, not swallow query errors, and cover external-SQLite init.
4. **MAJOR — tagged-wait selection:** replace envelope-first-fallback and
   shape-sniffing with the explicit opt-in contract (Phase 0 item 3);
   repro showed a permissive legacy schema persisting `null` instead of the
   signaled payload.
5. **MAJOR — rewind hardening:** no-snapshot fallback must be explicit;
   provenance cleanup failures must not be swallowed (stale seq reuse
   reorders new-branch history).
6. **MAJOR — test coverage:** same-key replacement retains seq; rewind
   provenance retention/deletion with ordering assertions; fork allocating
   child completions after inherited rows; crash-mid-transaction (not just
   clean close/reopen); real runtime rows (not artificial enumerable seq).
7. **MINOR — hygiene:** regen + commit llms bundles with the docs changes;
   signal-provenance clock extension (Phase 0 item 1, rev 3); WaitForEvent
   tagged-migration docs.
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

## Review response (Fable subagent, 2026-07-18, rev 2 → rev 3)

Verdict was APPROVE-WITH-CHANGES; all findings accepted. Dispositions:
1 (signal drop semantics unsound; listener races lose signals a live actor
would process) — ACCEPTED, and its recommendation (b) adopted as a design
change: `eventReceived` folds over `_smithers_signals` directly on the
shared provenance clock; listeners demoted to wake-and-park plumbing.
2 (retain-seq falsifies no-retroactivity + append-only claims under
payload replacement) — ACCEPTED; exception carved out, prefix cache must
validate by content hash. 3 (flagship example circular/undefined
identifier) — ACCEPTED; example fixed, "sources are pure functions of ctx"
rule added. 4 (migration paragraph didn't match landed contract; sniffing
hazard) — ACCEPTED; explicit opt-in contract specified, landed sniffing
implementation queued for correction. 5 (old or absent provenance silently
dropped; symbol seq lost on driver-storage round-trip) — ACCEPTED; spec
requires data-carried seq + surfaced warnings; correction backlog item 2.
6 (Phase 0 internal inconsistency) — ACCEPTED; decision moved into item 1
with rejected options recorded. 7 (rewind/provenance coupling +
no-snapshot fallback) — ACCEPTED; item 4 + backlog item 5. 8 (`ctx.outputs`
parenthetical inaccurate) — ACCEPTED; corrected. 9 (re-entry rule
generalizes; `id` unspecified) — ACCEPTED; general rule + lint + `id`
semantics added. 10 (boundary-inclusive `>=`) — ACCEPTED. 11 (version pin
unverifiable) — ACCEPTED; pin moved to Phase 1 lockfile.

The Phase 0 validation report and review moderator (run-1784406237546)
independently confirmed findings 5/7 at implementation level and added the
critical rewind regression, backfill, tagged-selection, `.d.ts`, and
coverage items — all captured in the correction backlog above.

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
**Correction status (2026-07-18):** Phase 0 correction backlog implemented and validated on this stack.
