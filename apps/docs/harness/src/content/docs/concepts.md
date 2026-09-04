---
title: "Concepts"
description: "The mental models behind @smthrs/harness: cells, the persistent realm, durable flow calls as the only I/O, and the governing designs the source JSDoc cites."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/harness/docs/concepts.md"
---

The source JSDoc in this package cites the design each module implements. This
page states each design: what it decides and where the decision is enforced.
Three mental models organize all of them: the cell, the persistent realm, and
the durable flow call.

## The cell loop

A run of the built-in agent is a sequence of frames. One frame is:

```text
model -> generated cell -> realm evaluation -> individually durable flow calls -> next transition
```

The model's whole answer is text, and the harness recovers a program from it:
every fenced `cell` block of the reply, joined in order into one JavaScript
program. That program is the cell. It runs inside a realm the run keeps, and
it states how the run should proceed by calling: `ctx.done(output)` completes
the run, `ctx.park(reason, message)` waits durably, and a cell that calls
neither continues to the next frame. `Sandbox.replTransition` builds the
`Cell.Transition` the journal records from that call.

The loop is cell-first rather than tool-call-first. The controller seals every
model request with `tools: []` and `toolChoice: "none"`, so continuation never
comes from provider plumbing: it comes from the transition the cell settled
and the budgets the run declared. A model that wants to read a file, run a
command, or ask a human writes JavaScript that awaits `ctx.call`, the same two
lines for every capability, and the harness turns each call into its own
durable boundary.

Four actors share the frame, and the package draws a hard line between them.
The model authors cells. The realm evaluates them. The controller (`CellTurn`)
decides what the transition means and what the next frame shows. The engine
(`EngineLike`) owns everything durable: sealed model steps, flow-call
settlements, journaled records, workspace measurement, checkpoints, and
suspension. The package is the translation between the four; scheduling,
persistence, transport, and model execution stay behind the ports.

## Repl realm

A run holds **one** realm for its whole life. The realm is the run's memory:
names bound by frame 3 are still bound in frame 9, so a cell reads what earlier
cells built instead of re-deriving it, and nothing is filed on the way out. What
the next model turn reads is what the frame printed.

Consequences the code enforces:

- `Sandbox.Realm` is acquired once and scoped to the run, not to a frame.
  `QuickJSSandbox.openRealm` is the only implementation that offers one.
- The per-frame budgets (`steps`, `timeMs`, `totalMs`) reset at each frame; the
  memory budget cannot, so `memoryBytes` is a **run** budget enforced by the
  panel probe at each frame's close.
- The realm is sealed per frame, not per run: `ctx.done` / `ctx.park` latch for
  the frame they were called in and the host clears the latch as the next frame
  opens.
- `VariablesPanel` exists because the value is still there under the name the
  panel prints. The panel measures each name cheaply rather than serializing it.

Implemented by `Sandbox.ts`, `QuickJSSandbox.ts`, `VariablesPanel.ts`.

## Durable cell loop

A frame is `model -> cell -> realm evaluation -> durable flow calls ->
transition`. Every `ctx.call` is its own keyed, journaled, permission-gated
boundary. On a compatible journal, a crash or a permission park mid-cell
re-executes source from the top and replays settled calls. This requires the
same controller format, declarations, and deterministic cell computation;
changing key material can turn a replay into a fresh call.

Harness journal format 2 changes summaries to user context. The agent session
checks persisted trace versions before opening model or cell boundaries, and
`CellTurn.run` rejects controller state decoded from an older format with typed
`HarnessError` code `incompatible_journal`. Start a new run for old journals;
rc.0 has no compatibility promise. Transcript projection is for display and
normalizes historical summary text to user messages; it does not authorize
resuming a historical run. The session trace is best-effort telemetry, while
the engine's sealed steps and recorded boundaries provide durable replay.

The controller's own reads of the world go through `EngineLike.record` for the
same reason. `(name, identity)` together key a record, and the controller folds
each boundary's purpose into its identity so it is correct even under an engine
that keys on identity alone.

Implemented by `CellTurn.ts`, `Cell.ts`, `EngineLike.ts`.

## Agent cell context

What a cell can see and reach, and nothing else:

- `ctx.call(flowName, input)` is the only authority. There is no `ctx.fs`, no
  `ctx.shell`, no `ctx.mcp`, no `ctx.spawn`.
- `ctx.flows` is the catalog, projected from the registry through
  `Cell.FlowProjection`, so the shape a cell reads is the shape the schema
  declares.
- `ctx.done`, `ctx.park` and `ctx.justify` are how a cell states its intent.
- `ctx.checkpoint()` mints a read-only view of the tree; a mint settles on the
  call channel and spends the call budget.

Implemented by `QuickJSSandbox.ts`'s prelude, `Cell.ts`, `internal/cellPrompt.ts`.

## Flow registry

A cell may call only what the registry disclosed to it, and it must call the
declaration it was shown. `Cell.declarationDigest` hashes the complete material
declaration, `Cell.CallIdentity` folds that digest into every call's identity,
and `CellCalls.make` re-derives it at the boundary: an entry that moved between
the frame that showed the catalog and the boundary that runs the call is refused
with `declaration_changed` rather than dispatched to a body the model never saw.

An executable binding answers before a discovered implementation, because a
binding is the implementation of the declaration it projected.

Implemented by `CellCalls.ts`, `FlowBinding.ts`, `Cell.ts`.

## Context window

The context assembled for one model request is immutable, provider-neutral, and
zoned, so a provider's prefix cache covers the stable span. Segments carry their
own digest and estimated token count, computed once at construction; the arrays
are frozen so a mutation cannot invalidate a cached digest silently.

The volatile block, the frame's state section, sits in one trailing user
message after the transcript rather than inside the system context, so the whole
stable span is byte-identical for the life of a run.

Compaction summaries are rendered as user messages, including summaries read
from older journal records. This keeps every compacted request anchored by a
leading user turn on providers that reject assistant-first conversations.

Implemented by `ContextWindow.ts`, `Tokens.ts`, `Compaction.ts`.

## Structured output

A boundary that must produce a typed value decodes the agent's final text
against the declared schema, spends a bounded number of correction re-prompts,
and then fails with a typed, coded failure rather than prose. The failure names
the schema digest, the candidate digest, the corrections spent, the budget, and
a bounded list of `{ path, message }` issues, so two identical-looking refusals
are distinguishable and a consumer branches on `code`.

Implemented by `StructuredOutput.ts`.

## Notification queue

Human steering reaches a run only at safe turn boundaries. The durable queue
decides which notifications a boundary may deliver; the harness folds what it
promoted into inserts and seat changes, journals the drain as a record so a
resumed run does not drain an already-drained queue, and never lets an
un-actionable steer look delivered.

Steering is considered after raised and rejected cells as well as successful
transitions. A completion is an idle boundary: queued follow-ups can keep the
run going. When the frame budget is exhausted, undeliverable notifications stay
pending in the durable queue for the host to carry forward.

Implemented by `Notifications.ts`, `Steering.ts`.

## Step keys and the model layer

A sealed model step is keyed on the exact wire request plus the declared key
material. Anything that says _how long the caller will wait_ rather than _what
the model was asked_ is deliberately not key material: a step keyed on a budget
would miss its cache the moment a host retuned it. `SealedModelStep.modelCallMs`
is the example, and it travels on the step so the number the controller journals
as armed is the number the engine enforces.

Implemented by `EngineLike.ts`, with the request shape owned by `@smthrs/model`.

## Child plans and the splice boundary

`Plan.Batch` describes children in source order; `EngineLike.splice` is the one
boundary that turns a batch into running children and streams their progress
back. The harness translates and never schedules.

Implemented by `Plan.ts`, `EngineLike.ts`.

## Model authoring surface

The cell contract is the text the model is taught with, and its size is a cost
the run pays every frame. It is pinned by a token ceiling in
`test/CellPrompt.test.ts`, so growing it is a deliberate act with a number
attached.

Implemented by `internal/cellPrompt.ts`.

## Citing this file from source

The JSDoc of this package cites these sections by package-relative path,
because `src/**` ships in the published tarball and a monorepo-rooted path does
not resolve once it is there: `../docs/concepts.md#<anchor>` from `src/`, and
`../../docs/concepts.md#<anchor>` from `src/internal/`. Section anchors are
therefore stable names; renaming a heading is a source-visible change.
