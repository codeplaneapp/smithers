# @smthrs/harness

This package declares `effect` as an exact
`4.0.0-rc.108` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://harness.smithers.sh

Built-in agent-loop contracts and pure turn helpers for flows. Scheduling, persistence, transport, and model execution stay behind explicit service ports.

```sh
npm install @smthrs/harness
```

## The cell loop

The primary loop is cell-first. A frame is `model -> generated cell -> realm evaluation -> individually durable flow calls -> next transition`: the model emits fenced `cell` blocks of JavaScript, they run as one program in a realm that outlives the frame and whose only effectful primitive is `ctx.call`, and the cell states its intent by calling — `ctx.done(output)` completes, `ctx.park(reason, message)` waits, and a cell that calls neither continues. `Sandbox.replTransition` turns that call into the `continue` / `complete` / `park` transition the journal records; nothing is returned and nothing is filed, because the realm is the memory and what a cell prints is what the next model turn reads. `CellTurn` is that controller; it decides continuation from the transition and the run's budgets, never from provider tool calls.

The production QuickJS binding never runs an unbounded cell. `Sandbox.defaultLimits` fills every ceiling a caller omits: 64 flow calls, 1,000 interpreter interrupt checks and a 30-second compute deadline per frame, a 900-second whole-evaluation backstop, a 120-second ceiling on any one flow call, and a 128 MiB memory budget. The memory budget is a **run** budget rather than a frame one, because the realm outlives its frames: `runtime.setMemoryLimit` does not count string data on the shipped build, so the panel probe weighs what the realm's own names hold and refuses a frame that opens over the ceiling before it runs. A caller may raise any individual ceiling explicitly; omitted ceilings retain their defaults, so a partial override cannot accidentally disable the others. `steps` and `timeMs` have typed floors (`Sandbox.minimumSteps`, `Sandbox.minimumTimeMs`), because a budget of zero interrupts the binding's own scaffolding rather than the cell.

The controller also keeps the script itself, for the one host that needs it. A frame throws its cell away once the realm has evaluated it, so a model that wants to turn the script it just ran into a saved flow has nothing to read back. `CellHistory` is where the source goes: the controller appends each cell as it executes it, before evaluation, so a cell that raised is still part of what the run ran. The service is optional — a host that offers no way to save a flow binds nothing and the controller records nothing — and `@smthrs/agent/PromoteFlows` is what reads it.

Every `ctx.call` inside a cell is its own keyed, journaled, permission-gated boundary at the tier the flow declares — a cell is never one opaque activity. That is what makes a crash or a permission park mid-cell recoverable: the cell source re-executes from the top, boundaries that already settled replay their recorded values, and execution reaches the parked call deterministically.

One case is bounded rather than free: a call the `callMs` ceiling interrupted settled nowhere, so a re-executed frame issues it to the host again and is then handed the recorded timeout. The cell's branch is stable either way; what the run pays for twice is the interrupted call. [`docs/api.md#durability`](./docs/api.md#durability) says why the call cannot move inside the record that would suppress it, and `CellTurn`'s `issued` says it again where it happens.

## Flows are the only capability primitive

A cell is handed exactly one authority: `ctx.call(flowName, input)`. There is no `ctx.fs`, no `ctx.shell`, no `ctx.mcp`, no `ctx.spawn` / `ctx.send` / `ctx.await`. Standard host capabilities, incoming MCP tools, and subagents are all _ordinary flow declarations plus a binding_, so a cell reaches every one of them with the same two lines and every one of them settles through the same durable `EngineLike.call` boundary with the same `CellCallStarted` / `CellCallSettled` trail.

`FlowBinding` is that contract: `Binding` pairs a flow declaration with its handler, decoding cell input through the flow's input schema and validating the handler's output back into serializable JSON; `Source` produces bindings, possibly lazily; `Catalog` composes ordered sources and refuses two implementations under one name; and `FlowBinding.registry` discloses a catalog through an ordinary `Registry.Registry`, with file-discovered entries keeping precedence. A correctable failure — bad input, a flow that failed, unserializable output — becomes a `failure` `Cell.CallResult` the cell may catch; a permission requirement, an abort, or a suspension stays in the typed error channel where the cell can neither see nor swallow it.

`@smthrs/agent/Agent` is the assembled production entry point that composes all of this over the durable engine.

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/harness/<Module>`. `QuickJSSandbox` is deliberately _not_ re-exported from the root: it carries an embedded WebAssembly build, so it is imported from its own subpath by hosts that want it.

The complete table of modules and their exports is generated from `src/index.ts` and the modules' own JSDoc: see [`docs/reference.md`](./docs/reference.md). It is not repeated here, because the hand-maintained copy that used to live here had drifted by seven modules and more than thirty exports.

`@smthrs/harness/QuickJSSandbox` exports `make` and `layer`: the QuickJS-WASM `Sandbox` binding, which runs the same single-file build on Node and in a browser and enforces the default ceilings above. It is also the one binding that offers `Sandbox.openRealm`, the persistent realm every run holds for its whole life ([`docs/concepts.md#repl-realm`](./docs/concepts.md#repl-realm)). It also exports `VariantService`, `Variant`, `layerVariantLive`, `layerVariant`, `makeWithVariant` and `layerWithVariant`, which are how a host names the build instead of taking the default; see below.

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
cd packages/smithers/agent/harness/test/workerd
npm install
node smoke.mjs
```

`smoke.mjs` starts `wrangler dev`, waits for the worker, and fails unless the cell completed. `npm run dev` serves the same worker on `http://127.0.0.1:8799` for hand inspection.

The smoke is **not** part of `pnpm --filter @smthrs/harness run test`. It needs a separate install and a downloaded runtime, so `test/WorkerdSmoke.test.ts` skips unless `FLOWS_WORKERD_SMOKE=1` is set:

```sh
FLOWS_WORKERD_SMOKE=1 pnpm --filter @smthrs/harness run test
```

`FLOWS_WORKERD_PORT` and `FLOWS_WORKERD_STARTUP_MS` override the port and the readiness deadline.

## Documentation

Everything published about this package is generated from package sources. See [`docs/README.md`](./docs/README.md) for the contract and the generator.

- [`docs/reference.md`](./docs/reference.md) — the generated reference: what each module is and every export it publishes.
- [`docs/api.md`](./docs/api.md) — the hand-written prose the reference is built around: durability, limits, byte units, failure categories.
- [`docs/concepts.md`](./docs/concepts.md) — the governing designs the source JSDoc cites.
- [`docs/history.md`](./docs/history.md) — the wave-by-wave development record, moved out of `CHANGELOG.md`.
