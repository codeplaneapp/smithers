---
title: "Concepts"
description: "The Smithers built-in agent loop: a cell-first controller whose model turns produce JavaScript cells that run in a persistent realm and reach the world only through durable flow calls"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/harness/docs/concepts.md"
---

The source JSDoc in this package cites the design each module implements. Those
designs used to live in a `docs/specs/` tree that is not part of this repository
and is not shipped in the published tarball, so a reader following a citation
found nothing. This file is the replacement: one section per design, stating
what it decides and where the decision is enforced. Cite it from JSDoc by its
path relative to the citing file — `../docs/concepts.md#<anchor>` from `src/`,
`../../docs/concepts.md#<anchor>` from `src/internal/` — because `src/**` ships
in the tarball and a monorepo-rooted path does not resolve once it is there.

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
boundary, so a cell is never one opaque activity: a crash or a permission park
mid-cell re-executes the cell source from the top, replays the boundaries that
already settled, and reaches the parked call deterministically.

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

The volatile block — the frame's state section — sits in one trailing user
message after the transcript rather than inside the system context, so the whole
stable span is byte-identical for the life of a run.

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
