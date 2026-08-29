# @smthrs/agent

The flows agent, and the two ways to run it.

`Agent` **is** the agent: one service whose single method runs one whole cell
loop on the durable engine. A **cell** is the JavaScript program the model emits
each frame; it runs in the sandbox, and its only authority is
`ctx.call(flowName, input)`, so every capability a cell reaches is an ordinary
flow settling through a durable boundary. The contract is
[`@smthrs/harness/Cell`](../harness/README.md#the-cell-loop).

`AgentSession` runs that agent as a durable control-plane run — the production
`ControlExecutor`, where the launch is a flow execution, the events go to the
journal, and an operator steers and approves it. `AgentAction` runs that same
agent as one typed step inside a larger flow, bounded by a declared output
schema and replayed like any other action.

Neither adapter reimplements the loop. A future agent that drives a foreign CLI
is another implementation of `Agent.Service`, not a second loop beside this one.

## `Agent`

`Agent.layer` provides the production implementation. It composes the whole cell
path — the controller in `@smthrs/harness/CellTurn`, registry-backed call
resolution in `@smthrs/harness/CellCalls`, the QuickJS sandbox, the durable
engine port in `./FlowEngineLike.ts`, the plugin kernel — and returns the
framework-neutral `Stream<AgentEvent>` the controller emits. There is no
callback, no event emitter, and no host-shaped result type; a caller renders the
stream, journals it, or ignores it.

```ts
import { Agent, ChildFlows, SeatResolver, StandardFlows } from "@smthrs/agent"
import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import type * as Path from "@smthrs/kernel/Path"
import { Effect, Stream } from "effect"
import type * as FileSystem from "effect/FileSystem"

// Inside a flow body — `FlowInstance` is per-execution.
const run = Effect.gen(function*() {
  const agent = yield* Agent.Agent
  // The host's resolver owns the credentials. `agent.run` only ever accepts a
  // seat that came out of one.
  const seats = yield* SeatResolver.SeatResolver
  const seat = yield* seats.resolve("anthropic:claude-opus-5")
  // Each standard flow takes exactly the context its handlers require, so the
  // two capabilities are built from two different slices of the host.
  const filesystemServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
  const shellServices = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | Path.Path
  >()
  return agent.run({
    session,
    seat,
    prompt: task,
    registry,
    // Capabilities are flows. All of them.
    flows: [
      StandardFlows.filesystem(filesystemServices),
      StandardFlows.shell(shellServices),
      ChildFlows.source(children)
    ],
    plugins
  }).pipe(Stream.provide(Agent.layerDefaults))
}).pipe(Effect.provide(Agent.layer))
```

`Seat.make` is documented as the resolved-seat constructor, and a `SeatResolver`
implementation is what calls it. A caller reaches a seat through the resolver,
never by assembling one from a model and a route it happened to hold.

`Agent.layerDefaults` supplies the two services a run leaves to the host —
the QuickJS sandbox and an empty steering source — with browser-safe defaults. A
host that accepts mid-run messages provides its own `Steering.layer` instead.

`Agent.layerDefaultsWithVariant` is the same pair over the QuickJS build the
host names, taken from `QuickJSSandbox.Variant`. A runtime that refuses to
compile WebAssembly from bytes, such as Cloudflare's workerd, uses it and
provides `QuickJSSandbox.layerVariant(variant)` beneath. See
`packages/harness/README.md` for how a worker builds that variant.

`flows` is an ordered list of `FlowBinding.Source`s; plugin `cellFlows` handlers
run after them, in resolution order. The composed catalog is what the model is
shown _and_ what the boundary resolves against, so the declaration digest a cell
was written against is the one checked when the call arrives. Duplicate names
fail composition rather than dispatching one descriptor to another
implementation.

- `StandardFlows` — `filesystem`, `shell`, `memory`, `clock` (a durable wait on
  the engine's `DurableClock`), and `approval` (a narrow injected `Asker` port,
  because a host with nobody to ask should refuse honestly rather than fake an
  answer).
- `ChildFlows` — subagents. An attached child needs nothing here: a dynamic or
  markdown flow called with `ctx.call` already runs inside its own durable
  boundary. Detached lifecycle — `agent/spawn`, `agent/send`, `agent/await` — is
  bound over an injected `Children` port, because nothing browser-safe can
  honestly claim to persist a detached run.
- `CellPlugin.fromBindings` — the one-liner for authoring a harness plugin that
  contributes capabilities.

The provider-tool-call loop is gone. `@smthrs/harness` deleted it along with
every module that existed only to serve it, and nothing replaced it beside the
cell path. A foreign-CLI agent returns as another implementation of
`Agent.Service`, not as a second loop.

## `Seat` and `SeatResolver`

A seat has two halves, and they live in different places on purpose.

The declared half is an ordinary string, and the package ships no schema for
it. It is what a markdown flow's `model:` frontmatter carries and what
`AgentAction`'s `seat` option takes. It carries no credentials, no endpoint, and
no client — a declaration is portable, and a run that reads one out of a
repository must not be handed the keys with it. `provider:modelId`
(`anthropic:claude-sonnet-4-5`) is the convention the Node CLI resolver
understands, not a rule the agent enforces.

`Seat.Seat` is the resolved half, and the only thing `Agent.run` accepts: a live
`Model`, the `RouteResolver` that seals its requests, and the model's context
window in tokens so compaction has a real budget. `Seat.make` constructs one,
and a `SeatResolver` implementation is what calls it.

`SeatResolver` is the seam between them, and the credentialed half of the
composition. `@smthrs/cli`'s `NodeControl` installs the resolver that reads keys
from the environment; a test installs one that answers with a scripted model and
never touches the network. `SeatResolver.contextWindowTokensFor` is the catalog
of known models, with a conservative floor — never zero, because zero is
`CellTurn`'s "compaction disabled". A seat the host cannot serve is a typed
`Seat.SeatUnresolved`, not a run that fails halfway through.

Because the resolver owns the seat vocabulary, a host may define its own. A
resolver that maps `reviewer` onto a particular model is an ordinary
implementation of its one method.

## `AgentSession`

`AgentSession.layer(options)` is the production `ControlExecutor` for
`@smthrs/control`: when the control plane accepts a launch, the session looks
the flow up in the registry, loads its markdown prompt body, resolves its
declared seat through `SeatResolver`, and runs the `Agent` service as the body
of one durable flow execution whose id is the control run id.

The composition declares what the spec demands of a host: explicit
`Sandbox.Limits` (never unlimited), a `Steering.Source` over the journal-backed
notification queue `Control.steer` admits into, and an approval `ask` gated in
`authorize` — before the durable boundary opens — that registers an in-run
approval token, parks the run with an encoded `Permission.PermissionRequired`,
and is re-decided against the grant store when `Control.approve` and
`Control.resume` bring the run back.

`@smthrs/cli`'s `NodeControl.layerExecutor` is the Node wiring: a `SeatResolver`
over real `Route.anthropic` / `Route.openai` routes with API keys read from the
environment, and `StandardFlows.filesystem/shell/memory` over the kernel's
guarded host layers.

The module also exports the pieces the session builds itself out of, and they
stay public because a host that runs the agent its own way needs the same ones:
`trace` and `patterns` are the projection half (agent events to durable
`control.agent.*` trail entries, declared capability strings to patterns), and
`waitForRunning`, `waitForParked`, `preserveDriverInterrupt`, `registerDriver`,
and `settleDriverFailure` are the wait and driver-lifecycle half.

## `AgentAction`

`AgentAction.make` declares an ordinary `Action` — same tag, same payload
schema, same `.call()`, same plan node, same durable replay — and ships the
implementation with it. An author never writes `toLayer` for a model call,
because there is only one implementation.

```ts
import { AgentAction } from "@smthrs/agent"
import * as Schema from "effect/Schema"

const Research = AgentAction.make("docs/Research", {
  payload: { topic: Schema.String },
  output: Schema.Struct({ summary: Schema.String }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant."],
  prompt: ({ topic }) => `Research ${topic}.`
})
```

The declared output schema is rendered into the run's system teaching and
enforced against the run's final answer; a decode miss spends a correction slot
on a re-prompt before it becomes a typed `StructuredOutputFailure`. The host
half is `AgentAction.Host` — the registry, the sandbox budget, and the catalog
every model-backed action in a composition shares — plus `SeatResolver` and
`Agent`. A test swaps the whole model for a scripted one by providing a
different `SeatResolver`.

### Composing it

Every layer a model-backed step needs, trimmed from
`examples/src/11-agent-step.ts`. `AgentAction.make` returns the declaration and
its `.layer` together, so the composition names the action once.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Agent, AgentAction, Seat, SeatResolver } from "@smthrs/agent"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const layer = Layer.mergeAll(
  Research.layer,
  Interpreter.layer(SimpleWorkflow)
).pipe(
  // The registry, the sandbox budget, and the catalog every model-backed
  // action shares, plus the credentialed seam and the agent itself.
  Layer.provideMerge(Layer.mergeAll(
    AgentAction.layerHost({ registry, limits: { calls: 8 }, capabilityEnvelope: [], maxFrames: 4 }),
    SeatResolver.layer({
      resolve: (id) => Effect.succeed(Seat.make({ id, model, route, contextWindowTokens: 200_000 }))
    }),
    Agent.layer
  )),
  // The QuickJS sandbox a cell runs in and the steering source it drains.
  Layer.provideMerge(Agent.layerDefaults),
  // Ordinary flow composition: action implementations, a durable engine, crypto.
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
```

### Watching it run

A step answers with one decoded value, which it only knows at the end. Provide
`EventSink` to also receive each agent event as it happens: token deltas, the
cell that was produced, the calls it made. The step still buffers every event
for the decode, so the answer, the correction budget, and the failures are the
same with a sink as without one.

```ts
import { EventSink } from "@smthrs/agent"
import * as Effect from "effect/Effect"

const watched = Layer.merge(
  layer,
  EventSink.layer({ emit: (event) => Effect.sync(() => render(event)) })
)
```

`emit` runs inside the frame that produced the event, and that frame holds the
engine's write transaction. A sink pushes onto a queue, writes to a socket, or
resolves a deferred. A sink that waits on a durable write stalls the run.

## The engine port

`@smthrs/harness` owns the _port_ — `sealStep`, `call`, `splice`, `record`,
`suspend` — and ships only `EngineLike.layer(implementation)` and
`EngineLike.layerNoop()`. It deliberately does not depend on any engine: the
browser app supplies its own in-tab implementation, and pulling the durable
engine into the port package would put it in every harness consumer's bundle.
`FlowEngineLike` is the other implementation, kept separate for the same reason
`platform-node` is separate from the platform contracts in the effect repo.

```ts
import { FlowEngineLike } from "@smthrs/agent"
import { Effect } from "effect"

// Inside a flow body — `FlowInstance` is per-execution.
const program = Effect.gen(function*() {
  const engine = yield* FlowEngineLike.make({
    model,
    route: FlowEngineLike.routeResolver(anthropic),
    calls: { authorize: (call) => checkGrants(call), run: (call) => runFlow(call) }
  })
  // ...provide `engine` to the harness.
})
```

## What durability buys

- **`sealStep`** resolves the route, runs `Route.prepare`, and digests the
  credential-free prepared request together with the harness's declared key
  material into a `StepKey`. That key is the sealed activity's idempotency key:
  a replayed turn re-emits the recorded model events instead of calling the
  provider again, and a provider wire change produces a new key. Credentials
  are signed on after the digest and never enter it.
- **`call`** runs one flow call from inside a running cell as its own activity
  at the tier the flow declares. A sealed call is content-addressed on its
  declaration digest, resolved layers, declared capabilities, and arguments, so
  it replays wherever it appears; anything else folds in the whole cell
  identity — session, frame, cell digest, and the call's execution ordinal — so
  two invocations stay distinct, an irreversible effect is run-scoped, and a
  cell re-executed after a park replays exactly the boundaries that already
  settled. Authorization is checked _before_ the activity opens: an activity's
  outcome is journaled, so a permission requirement raised from inside one
  would replay forever and no later grant could unblock it.
- **`splice`** runs each elaborated child as its own activity at the tier the
  child declares. A sealed child is content-addressed and replays; a
  compensable or irreversible child folds the run scope — the flow and
  execution the port was built inside — and the model's `callId` into its key,
  so two invocations of one declaration stay distinct steps and two runs that
  both labelled a call `call-1` cannot alias onto one another. That is also
  what lets the engine retry an irreversible activity at all.
- **Composition identity.** `Options.layers` is the resolved layer stack and
  plugin list the host actually built, and it is folded into every key this
  port derives. A boundary resolved under a different composition is a
  different boundary, so a plugin swap can never be served a recorded result
  from the composition it replaced. The port also declares that layer set as
  the engine's content environment (`Activity.CurrentContentEnvironment`).
- **Authority identity.** The other half of the content environment is
  `Options.capabilities`, and the port never invents it. A sealed boundary is
  cross-run cacheable, so a result computed under a broad capability envelope
  must not be served to a run with an attenuated one, even when the call
  declares identical capabilities — the envelope is what attenuates it
  (issue #75). Supplying the composition's **complete** authority is what
  makes a sealed boundary shareable across runs; omitting it is the honest
  "unknown", and the engine answers it by pinning every sealed key to the
  current execution. `Agent.run` declares the capability envelope it actually
  built, so hosts on that path get cross-run reuse without asserting anything
  false.
- **`record`** journals one nondeterministic controller read — the
  turn-boundary steering drain — as its own run-scoped boundary. A resumed
  run replays the recorded drain instead of reading an already-drained queue,
  which is what keeps a resume on the original attempt's sealed steps.
- **`suspend`** is a real durable suspension (`Flow.suspend`). The execution
  parks and the engine can resume it, rather than the port failing.

## Saving the script a run just wrote

A run that solved something once solved it as a script: a few cells that read the right things, called the right boundaries, and printed an answer. `PromoteFlows` is how that script becomes a flow anyone can call again, and it is two ordinary flows rather than a new affordance.

`flows/show-script` hands the model its own turn back — the source of every cell it executed, in order — together with the rules a saved flow has to follow and the file skeleton to fill in. It reads `@smthrs/harness/CellHistory`, the optional service the cell controller records into, so a host that keeps no history reports an empty script instead of failing. `flows/write-flow` takes the three files that come back — the flow, its end-to-end test, and the fixture that test replays — and writes them through a `FlowStore`. When a `Registry` is in context it is refreshed afterwards, which is what makes the saved flow appear in `ctx.flows` on the next frame rather than the next run.

`FlowStore` is where the files land, and the host decides where that is: `FlowStore.layerFileSystem(root)` writes `<root>/flows/<id>/{flow.ts,flow.e2e.ts,fixtures/<id>.json}` through Effect's `FileSystem`, `FlowStore.layerMemory()` keeps them in a map, and `FlowStore.layerNoop()` refuses with a message the model can read. The store is also the last place an id is still text, so `FlowStore.validateId` runs before any path is built from it: `../escape` is refused as a bad id rather than caught as a surprising write. The rules and the skeleton are the host's too — `PromoteFlows.Options` replaces both for a host whose flows are laid out differently.

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/agent/<Module>`.

| Module                     | Public exports                                                                                                                                                                                                   | Description                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `FlowEngineLike`           | `RouteResolver`, `routeResolver`, `ChildRunner`, `CallRunner`, `WorkspaceCallRunner`, `workspaceRelative`, `callBoundary`, `callMaterial`, `appendBatch`, `sandboxed`, `Options`, `make`, `layer`                | Executes the `@smthrs/harness` engine port on the durable engine from `@smthrs/engine`. |
| `Agent`                    | `Options`, `Service`, `Agent`, `make`, `makeNoop`, `layer`, `layerNoop`, `layerDefaults`, `layerDefaultsWithVariant`                                                                                             | Composes the durable cell loop and emits it as a `Stream<AgentEvent>`.                  |
| `Seat`                     | `Seat`, `make`, `SeatUnresolved`, `modelIdOf`                                                                                                                                                                    | Models the resolved seat a run streams from, and the failure of resolving one.          |
| `SeatResolver`             | `Service`, `SeatResolver`, `make`, `makeNoop`, `layer`, `layerNoop`, `contextWindowTokensFor`                                                                                                                    | Turns a declared seat string into a live model, and holds the credentials that takes.   |
| `CellPlugin`               | `hooks`, `make`, `registry`, `flows`, `fromBindings`, `modelRequest`, `identity`                                                                                                                                 | Hosts the cell registry, flow, and model-request hooks on the shared plugin kernel.     |
| `StandardFlows`            | `filesystem`, `shell`, `memory`, `WaitInput`, `WaitOutput`, `waitFlow`, `clock`, `AskInput`, `AskOutput`, `askFlow`, `ApprovalUnavailable`, `Asker`, `approval`, `askerNoop`                                     | Expresses the built-in host capabilities as ordinary executable flows.                  |
| `AgentSession`             | `Options`, `trace`, `patterns`, `waitForRunning`, `waitForParked`, `preserveDriverInterrupt`, `registerDriver`, `settleDriverFailure`, `make`, `layer`                                                           | Runs one control-plane launch as one durable agent session.                             |
| `ChildFlows`               | `SpawnInput`, `SpawnOutput`, `SendInput`, `SendOutput`, `AwaitInput`, `AwaitOutput`, `spawnFlow`, `sendFlow`, `awaitFlow`, `ChildError`, `Children`, `makeNoop`, `source`                                        | Expresses detached subagent lifecycle as ordinary executable flows.                     |
| `PromoteFlows`             | `bestPractices`, `flowTemplate`, `ShowScriptInput`, `ShowScriptOutput`, `WriteFlowInput`, `WriteFlowOutput`, `showScriptFlow`, `writeFlowFlow`, `Options`, `source`                                              | Turns the script the model just ran into a saved flow, as two ordinary flows.           |
| `FlowStore`                | `FlowStoreErrorCode`, `FlowStoreError`, `idPattern`, `validateId`, `SavedFlow`, `WriteResult`, `Service`, `FlowStore`, `makeMemory`, `makeFileSystem`, `makeNoop`, `layerMemory`, `layerFileSystem`, `layerNoop` | Writes a saved flow's files and lists the flows a host already holds.                   |
| `WorkspaceSandbox`         | Every export of [`@smthrs/engine-store/WorkspaceSandbox`](../engine-store/README.md), including `Service`, `WorkspaceSandbox`, `make`, `layer`, `Host`, `makeHosted`, `makeMemory`, and `layerFileSystem`        | Re-exports the canonical workspace transaction contract, unchanged.                     |
| `InMemoryWorkspaceSandbox` | `InitialFiles`, `HostFile`, `InMemoryWorkspaceSandbox`, `make`                                                                                                                                                   | Builds that contract's conformance sandbox over an in-memory host.                      |
| `AgentAction`              | `Host`, `makeHost`, `layerHost`, `AgentFailure`, `PayloadSchemaOf`, `Options`, `AgentAction`, `make`                                                                                                             | Declares a model-backed step as an ordinary action and ships its implementation.        |
| `EventSink`                | `Service`, `EventSink`, `make`, `makeNoop`, `layer`, `layerNoop`                                                                                                                                                 | Hands a host each agent event while the step runs, instead of only after it decodes.    |

`@smthrs/agent/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

## Not to be confused with

`@smthrs/testing`'s `FlowEngineLike` adapts the same engine to a different
port — `EngineSubject` (`run` / `result` / `interrupt` / `resume` / `journal`),
the testing library's conformance contract. The two share a backing engine and
nothing else.
