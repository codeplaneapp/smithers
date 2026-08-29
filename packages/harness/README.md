# @smthrs/harness

Built-in agent-loop contracts and pure turn helpers for flows. Scheduling, persistence, transport, and model execution stay behind explicit service ports.

```sh
npm install @smthrs/harness
```

## The cell loop

The primary loop is cell-first. A frame is `model -> generated cell -> realm evaluation -> individually durable flow calls -> next transition`: the model emits fenced `cell` blocks of JavaScript, they run as one program in a realm that outlives the frame and whose only effectful primitive is `ctx.call`, and the cell states its intent by calling — `ctx.done(output)` completes, `ctx.park(reason, message)` waits, and a cell that calls neither continues. `Sandbox.replTransition` turns that call into the `continue` / `complete` / `park` transition the journal records; nothing is returned and nothing is filed, because the realm is the memory and what a cell prints is what the next model turn reads. `CellTurn` is that controller; it decides continuation from the transition and the run's budgets, never from provider tool calls.

The production QuickJS binding never runs an unbounded cell. When a caller omits limits, each evaluation gets a 128 MiB heap ceiling, 1,000 interpreter interrupt checks, and a 30-second wall-clock deadline. A caller may raise any individual ceiling explicitly; omitted ceilings retain their defaults, so a partial override cannot accidentally disable the others.

The controller also keeps the script itself, for the one host that needs it. A frame throws its cell away once the realm has evaluated it, so a model that wants to turn the script it just ran into a saved flow has nothing to read back. `CellHistory` is where the source goes: the controller appends each cell as it executes it, before evaluation, so a cell that raised is still part of what the run ran. The service is optional — a host that offers no way to save a flow binds nothing and the controller records nothing — and `@smthrs/agent/PromoteFlows` is what reads it.

Every `ctx.call` inside a cell is its own keyed, journaled, permission-gated boundary at the tier the flow declares — a cell is never one opaque activity. That is what makes a crash or a permission park mid-cell recoverable: the cell source re-executes from the top, boundaries that already settled replay their recorded values, and execution reaches the parked call deterministically.

## Flows are the only capability primitive

A cell is handed exactly one authority: `ctx.call(flowName, input)`. There is no `ctx.fs`, no `ctx.shell`, no `ctx.mcp`, no `ctx.spawn` / `ctx.send` / `ctx.await`. Standard host capabilities, incoming MCP tools, and subagents are all _ordinary flow declarations plus a binding_, so a cell reaches every one of them with the same two lines and every one of them settles through the same durable `EngineLike.call` boundary with the same `CellCallStarted` / `CellCallSettled` trail.

`FlowBinding` is that contract: `Binding` pairs a flow declaration with its handler, decoding cell input through the flow's input schema and validating the handler's output back into serializable JSON; `Source` produces bindings, possibly lazily; `Catalog` composes ordered sources and refuses two implementations under one name; and `FlowBinding.registry` discloses a catalog through an ordinary `Registry.Registry`, with file-discovered entries keeping precedence. A correctable failure — bad input, a flow that failed, unserializable output — becomes a `failure` `Cell.CallResult` the cell may catch; a permission requirement, an abort, or a suspension stays in the typed error channel where the cell can neither see nor swallow it.

`@smthrs/agent/Agent` is the assembled production entry point that composes all of this over the durable engine.

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/harness/<Module>`. `QuickJSSandbox` is deliberately _not_ re-exported from the root: it carries an embedded WebAssembly build, so it is imported from its own subpath by hosts that want it.

| Module             | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Description                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `AgentEvent`       | `TurnOpened`, `ModelDelta`, `ModelSettled`, `CellProduced`, `CellCallStarted`, `CellCallSettled`, `CellSettled`, `TransitionApplied`, `Suspended`, `CompactionSettled`, `SteeringDrained`, `TurnClosed`, `PermissionRequired`, `Aborted`, `Resolved`, `AgentEvent`                                                                                                                                                                                                                         | Defines the schema-backed event stream emitted by an agent turn.                  |
| `Cell`             | `Language`, `Source`, `digestOf`, `source`, `ContextEntry`, `Continue`, `Complete`, `Park`, `Transition`, `renderText`, `RejectionCode`, `Settled`, `Raised`, `Rejected`, `Outcome`, `FlowProjection`, `project`, `CallFailureCode`, `defaultCallFailureCode`, `callFailureHint`, `CallIdentity`, `declarationDigest`, `Call`, `baseCheckpoint`, `checkpoint`, `checkpointOf`, `CallResult`, `callFailure`, `Extracted`, `extract`                                                         | Models cell source, its transition, its outcomes, and every call identity.        |
| `CellTurn`         | `defaultMaxFrames`, `State`, `Input`, `make`, `teach`, `run`                                                                                                                                                                                                                                                                                                                                                                                                                               | Runs the cell-first controller as a stream of agent events.                       |
| `CellValidation`   | `Validation`, `validate`, `normalize`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Parses a cell at the boundary and reports what the parse alone can decide.        |
| `CellHistory`      | `ExecutedCell`, `Service`, `CellHistory`, `make`, `makeCells`, `makeNoop`, `layer`, `layerCells`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                              | Records the source of every cell the current turn executed.                       |
| `CellCalls`        | `Implementation`, `Prompt`, `PromptRunner`, `Options`, `Resolver`, `make`                                                                                                                                                                                                                                                                                                                                                                                                                  | Resolves the flow calls a cell makes against the registry and dispatches them.    |
| `Compaction`       | `summaryInstruction`, `InvalidStep`, `Summarizer`, `CompactionStep`, `TokenAccounting`, `shouldCompact`, `selectPrefix`, `declare`, `summaryRequest`, `apply`                                                                                                                                                                                                                                                                                                                              | Selects and applies deterministic context compaction.                             |
| `ContextWindow`    | `TypeId`, `SegmentKind`, `SegmentZone`, `Content`, `ContextWindowErrorCode`, `ContextWindowError`, `Segment`, `ContextWindow`, `SegmentInput`, `MakeOptions`, `makeSegment`, `make`, `empty`, `appendTurn`, `activateTools`, `prefixDigest`, `compactPrefix`, `compact`, `render`                                                                                                                                                                                                          | Maintains immutable, zoned context segments and their rendered projection.        |
| `EngineLike`       | `SuspendReasonCode`, `SuspendReason`, `SealedModelStep`, `EngineLike`, `make`, `layer`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                            | Defines the engine callbacks used for child planning, suspension, and completion. |
| `FlowBinding`      | `Declared`, `DescriptorOptions`, `descriptorOf`, `Binding`, `Options`, `make`, `provide`, `Source`, `source`, `Catalog`, `empty`, `catalogResult`, `catalog`, `registry`                                                                                                                                                                                                                                                                                                                   | Pairs ordinary flow declarations with their handlers and composes them.           |
| `HarnessError`     | `HarnessErrorCode`, `HarnessError`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Defines typed harness failures.                                                   |
| `Notifications`    | `Options`, `make`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Adapts the durable notification queue into turn input.                            |
| `Plan`             | `Child`, `Batch`, `ChildResult`, `ChildProgress`, `ChildSettled`, `SpliceEvent`                                                                                                                                                                                                                                                                                                                                                                                                            | Models child-plan batches and their progress and splice events.                   |
| `Sandbox`          | `SandboxErrorCode`, `SandboxError`, `Invocation`, `Mint`, `Minter`, `mintUnavailable`, `Handler`, `Limits`, `Capabilities`, `defaultLimits`, `minimumMemoryBytes`, `printFrameBytes`, `printStatementFloor`, `printRetainedBytes`, `withDefaults`, `Intent`, `replTransition`, `RealmEvaluation`, `RealmFrame`, `Realm`, `RealmOptions`, `Sandbox`, `make`, `layer`, `makeNoop`, `layerNoop`, `realmUnsupported`, `compile`, `PendingCall`, `Latch`, `latch`, `driveCell`, `raisedOutcome` | Declares the deterministic script sandbox port and its dependency-free binding.   |
| `Steering`         | `Delivery`, `SteerInsert`, `QueueInsert`, `Insert`, `SeatChange`, `ThinkingChange`, `ActivateTools`, `Item`, `Queue`, `Drain`, `BoundaryInput`, `PromotionState`, `empty`, `enqueue`, `drainAtClose`, `promoteAtIdle`, `Source`, `SourceInput`, `make`, `makeNoop`, `layer`, `layerNoop`                                                                                                                                                                                                   | Queues, promotes, and drains human steering at safe turn boundaries.              |
| `StructuredOutput` | `StructuredOutputFailure`, `maxIssues`, `jsonSchema`, `digest`, `instructions`, `correction`, `lastBalanced`, `candidates`, `decode`                                                                                                                                                                                                                                                                                                                                                       | Decodes an agent's final text into the declared output schema or a typed failure. |
| `Tokens`           | `Count`, `Segment`, `Accounting`, `Estimator`, `estimate`, `count`, `combine`                                                                                                                                                                                                                                                                                                                                                                                                              | Estimates token usage and combines accounting records.                            |
| `Transcript`       | `TranscriptErrorCode`, `TranscriptError`, `ProjectedMessage`, `ProjectedState`, `CellEvidence`, `projectStateResult`, `projectResult`                                                                                                                                                                                                                                                                                                                                                      | Projects journal entries into model-facing transcript state.                      |
| `VariablesPanel`   | `bound`, `Binding`, `Stamp`, `Ledger`, `stamp`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                   | Renders what the realm holds and when each name was last bound.                   |

`@smthrs/harness/QuickJSSandbox` exports `make` and `layer`: the QuickJS-WASM `Sandbox` binding, which runs the same single-file build on Node and in a browser and enforces the default ceilings above. It is also the one binding that offers `Sandbox.openRealm`, the persistent realm every run holds for its whole life (`docs/specs/Concepts/Repl Realm.md`). It also exports `VariantService`, `Variant`, `layerVariantLive`, `layerVariant`, `makeWithVariant` and `layerWithVariant`, which are how a host names the build instead of taking the default; see below.

`@smthrs/harness/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

## Naming the QuickJS build

`make` and `layer` compile the single-file build from bytes, which is what Node and a browser want. Some runtimes forbid that. Cloudflare's workerd runs no WebAssembly it did not compile itself: `WebAssembly.compile` over bytes fails at runtime, and the only module a worker can instantiate is one its toolchain bundled and handed over as an import.

`QuickJSSandbox.Variant` is that seam. `layerVariantLive` provides the single-file default and `layerVariant(variant)` provides a build the host names; `layerWithVariant` and `makeWithVariant` are the sandbox over whichever one is in context. `@smthrs/agent/Agent` carries the same pair: `layerDefaults` is unchanged and `layerDefaultsWithVariant` takes the build from context.

A worker names its build with the `.wasm` module its bundler compiled:

```ts
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { Layer } from "effect"
import { newVariant } from "quickjs-emscripten-core"

const layer = QuickJSSandbox.layerWithVariant.pipe(
  Layer.provide(QuickJSSandbox.layerVariant(newVariant(wasmfile, { wasmModule })))
)
```

`test/QuickJSVariant.test.ts` runs a cell against a variant built that way under Node, reading and compiling the `.wasm` file itself in place of the bundler.

## The workerd smoke

`test/workerd/` is a wrangler project that imports the sandbox, names the bundled `.wasm` module, and runs one cell in its `fetch` handler. It is not a pnpm workspace member, because wrangler ships the workerd binary and nothing else in the repository needs it.

```sh
cd packages/harness/test/workerd
npm install
node smoke.mjs
```

`smoke.mjs` starts `wrangler dev`, waits for the worker, and fails unless the cell completed. `npm run dev` serves the same worker on `http://127.0.0.1:8799` for hand inspection.

The smoke is **not** part of `pnpm --filter @smthrs/harness run test`. It needs a separate install and a downloaded runtime, so `test/WorkerdSmoke.test.ts` skips unless `FLOWS_WORKERD_SMOKE=1` is set:

```sh
FLOWS_WORKERD_SMOKE=1 pnpm --filter @smthrs/harness run test
```

`FLOWS_WORKERD_PORT` and `FLOWS_WORKERD_STARTUP_MS` override the port and the readiness deadline.
