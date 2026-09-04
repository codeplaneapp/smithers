# @smthrs/flows

The aggregate entry point re-exports every durable-engine package without
flattening neighboring constructors. [`@smthrs/flow`](/api/flow) authoring
names are flat, and `TimeTravel` is a flat service key; infrastructure packages
remain namespaces.

```sh
pnpm add @smthrs/flows@next
```

```ts
import { Action, Flow, Kernel, RunStore } from "@smthrs/flows"
```

The root entry point bundles for browsers, but rc.0 durable execution is
supported only on Node.js >= 22.19.0 with local SQLite. Browser and edge
runtimes may author and inspect declarations; supplying another SQL client does
not make them supported durable hosts.

## Aggregate exports

<!-- generated:namespaces -->

Platform bundles are deliberately absent. A program chooses
`@smthrs/platform-node`, `@smthrs/platform-bun`, or
`@smthrs/platform-browser` directly.

The `Capability` namespace re-exports `@smthrs/capability`; its exact-resource
bounds, pattern grammar, and permission failures are documented in the
[capability API](/api/capability).

The `Plan` namespace re-exports [`@smthrs/plan`](/api/plan), which owns step
identity, graph compilation, static effect declarations, and plan storage.

The `Journal` namespace re-exports [`@smthrs/journal`](/api/journal), which owns
the append-only event record every durable run is replayed from, and the
redaction rules that keep a credential out of both a committed row and a log
line.

## NodeRuntime

`@smthrs/flows/NodeRuntime` is the only supported durable-runtime subpath in
rc.0. `layer` leaves host services, the step boundary, and workspace sandbox to
the caller. `layerHost` supplies the contained Node host, guarded action
surface, storage, engine, liveness probe, and bounded signal shutdown.

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

const runtime = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: ".",
    owner: { hostId: "local-worker" }
  },
  registerFlows
)
```

The journal queue has capacity 1,024 and rejects overflow. Artifacts live next
to the database under `.flows/objects`. Engine snapshot bookkeeping uses a
private Jj service; `HostOptions.rules` controls only action-facing authority.
Signals are validated and deduplicated before installation, and
`shutdownTimeoutMs` must be an integer from 0 through 2,147,483,647.

<!-- generated:node-runtime -->

## SandboxedFlow

`@smthrs/flows/SandboxedFlow` runs a child flow's OWN CODE inside a machine a
`Sandbox.Provider` provisions. `Sandbox.layerHost` places a body's side effects
on a machine while its TypeScript keeps running in the engine host; this
subpath is the tier above it, the 0.x `<Sandbox workflow={child}>` component
rebuilt on the 1.0 seams. It is Node-only: it bundles with esbuild and it
starts a guest runtime.

```ts
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"

const result = yield* SandboxedFlow.execute(Child, { n: 31 }, {
  provider,
  session: `child:${executionId}`,
  entry: new URL("./child.ts", import.meta.url),
  runtime: "node",
  collectDiff: true
})
// result.output is Child's success value, decoded through Child's own schema.
// result.diff is the files the guest created, as { path, bytes } data.
```

Two 0.x mistakes stay out. `provider` is a `Sandbox.Provider` value passed in;
there is no string registry, no lookup by name, and no environment-variable
default. And the authoring is `Flow.make` and `Action.make`; there is no
component to place.

### The runner protocol

| Step    | What happens                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bundle  | esbuild bundles `entry` (`platform: "node"`, ESM) with the guest runner into one `.smithers-sandbox/bundle.mjs` under the session workdir.                                                                                                                                                                                                                                                                                   |
| request | `.smithers-sandbox/request.json` holds `{ flow, executionId, payload }`: the flow's tag, the session key as the guest execution id, and the payload encoded through `Schema.toCodecJson` of the flow's payload schema.                                                                                                                                                                                                       |
| run     | The guest runtime (`node` by default, `bun`, or any command line) runs the bundle with the workdir as its working directory and `SMITHERS_SANDBOX_REQUEST_PATH` and `SMITHERS_SANDBOX_RESULT_PATH` set, the 0.x variable names.                                                                                                                                                                                              |
| guest   | The runner finds the flow by tag among the entry's exports, decodes the payload, runs the flow under `FlowEngine.layerMemory` with `Interpreter.layer`, `Action.layerImplementations`, the entry's `layer`, and a WebCrypto `Crypto`, and writes `.smithers-sandbox/result.json`: `{ status: "finished", output }` with the success value encoded through the success schema's JSON codec, or `{ status: "failed", error }`. |
| result  | The host refuses a non-zero exit, a missing or unparseable result, and a result over the limits, then decodes `output` through the same codec. Every refusal is a typed `SandboxedFlowError` whose `code` names it and whose message quotes the guest's stdout and stderr.                                                                                                                                                   |
| diff    | With `collectDiff`, the host lists the workspace before and after the run and reads back every file the guest created or resized, under the limits.                                                                                                                                                                                                                                                                          |

The entry module exports the flow under any name, and may export `layer`, an
Effect `Layer` providing the implementations of the actions the flow's body
names and the `Interpreter.layer` registration of any flow it calls as
`.child()`. The in-memory engine is the guest composition because the child
completes inside one guest process and the parent journals the whole
execution as one durable action; an in-guest SQLite journal would put
`node:sqlite`, the migration ladder, and a `Jj` stub into every bundle without
changing the durability the parent can observe.

### Image requirements

The guest image must contain the runtime the bundle is started with: `node`
22 or later, or `bun`, on the guest's `PATH`. Nothing is installed. A missing
runtime is a `guest_failed` failure that names it (`node:22-alpine` has one;
`alpine` does not). The entry's imports of `effect`, `@smthrs/flow`, and
`@smthrs/engine` must resolve to the installation the host's `@smthrs/flows`
uses, which the single-version rule already guarantees in a workspace.

### Limits

| Bound         | Default | 0.x counterpart         |
| ------------- | ------- | ----------------------- |
| `resultBytes` | 5 MiB   | the 5 MB manifest limit |
| `diffBytes`   | 100 MiB | the 100 MB bundle total |
| `files`       | 1,000   | the 1,000 patch files   |

`timeout` is a wall-clock budget for the whole session, ten minutes by
default, measured on the platform timer so it fires under a frozen test clock.

### The diff is data, not an applied change

`result.diff` is `{ path, bytes }` per created or resized file, path relative
to the workdir. Change detection compares sizes by path against a snapshot
taken before the run: a file rewritten in place at its previous size on a
reattached workspace is the one edit it misses, and a fresh workspace holds
nothing but the protocol's own files. Applying the diff on the host is the
caller's; the 0.x `reviewDiffs` gate, which held changed bundles until a
person accepted them, is the recorded follow-up of this pass and does not
ship here.

### One durable action for the parent

`action(flow)` declares an `Action` over the child's payload schema whose
success is `{ output, diff }` and whose error is `SandboxedFlowError`, and
`toLayer(action, flow, options)` implements it with `execute`. The parent's
body calls it like any action, the engine journals one attempt, and the
session key can derive from the parent execution:

```ts
const RunChild = SandboxedFlow.action(Child)

const Parent = Flow.make("app/Parent", {
  payload: { n: Schema.Number },
  success: SandboxedFlow.resultSchema(Schema.Number),
  error: SandboxedFlow.SandboxedFlowError,
  body: (payload) => RunChild.call(payload)
})

const implementation = SandboxedFlow.toLayer(RunChild, Child, ({ executionId }) => ({
  provider,
  session: `child:${executionId}`,
  entry: new URL("./child.ts", import.meta.url)
}))
```

A session key is an exclusive claim: two live executions with one key share a
machine and the first to finish tears it down under the other. Reusing a key
is what resume looks like, because a crash that left the machine behind is
reattached, workspace included, by the next execution with the same key.

<!-- generated:sandboxed-flow -->

Use individual `@smthrs/*` packages when a smaller dependency surface is
preferable.
