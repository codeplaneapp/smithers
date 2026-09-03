# Smithers

**Durable agent workflows that survive the process running them.**

[![CI](https://github.com/smithersai/smithers/actions/workflows/ci.yml/badge.svg)](https://github.com/smithersai/smithers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](#license)
[![Docs](https://img.shields.io/badge/docs-smithers.sh-2563eb)](https://smithers.sh)

> **Release candidate.** This tree builds `1.0.0-rc.0`. It is a source migration,
> not a compatible upgrade from Smithers 0.x. There is no JSX workflow API, no
> `smthrs/jsx-runtime`, no React reconciler, no `<Workflow>` or `<Task>`
> components, no `createSmithers`, no `smthrs` facade, and no way to load or
> resume a 0.x run database. No shim or compatibility layer will be published.
> Read [Compatibility](#compatibility) before you upgrade.

Smithers is a durable-execution engine built on Effect. A flow is a typed program
whose side effects are recorded in a journal as they happen. When the process
running it dies, the next process reads the journal and continues where the
record stops. Agents, approvals, retries, and time travel are all built on that
one mechanism.

Effect ships a workflow package of its own. This engine vendors that surface
rather than depending on it, then diverges by being stricter and more cacheable.
Upstream derives a run's identity by hashing the flow tag and payload, so
unrelated runs with equal payloads silently join; here the caller chooses the
execution ID, derivation is opt-in, and a flow with neither dies with a
structured defect. Upstream derives a step's identity from its activity's name,
so renaming an activity corrupts replay; here step keys are content-addressed
over canonical JSON, and a step is keyed by its content, not its name. Upstream
retries any interruption ten times by default; here cancellation propagates at
once, and only an interrupt explicitly marked as infrastructure consumes a retry
policy.

## Quick start

You need Node.js 22.19.0 or later. The durable engine runs on Node only.

```sh
pnpm add @smthrs/flow@next @smthrs/engine@next effect@4.0.0-rc.108 @effect/platform-node@4.0.0-rc.108 @effect/platform-node-shared@4.0.0-rc.108
```

Release candidates publish to the `next` dist-tag, so the `@next` suffix is
required. `latest` still resolves the Smithers 0.x line. Install
`@smthrs/cli@next` for the `smithers` command. Pin Effect to exactly
`4.0.0-rc.108`: a project with two Effect instances is unsupported, because
schema internals are not interoperable between them.

`@effect/platform-node-shared` is on that line because
`@effect/platform-node@4.0.0-rc.108` asks for it as `^4.0.0-rc.108`, the
registry answers `4.0.0-rc.112`, and that version's own peer range demands
Effect `4.0.0-rc.112`. Naming the package yourself settles the range: npm, Bun,
and pnpm each then resolve one copy, at `4.0.0-rc.108`.

If you installed without it, `npm ls --all` exits 1 with
`invalid: "^4.0.0-rc.112"`, while bare `npm ls` exits 0 because the drifted copy
nests below the depth it prints. Adding the package repairs the tree in place,
with no reinstall:

```sh
npm install --save-exact @effect/platform-node-shared@4.0.0-rc.108
```

An `overrides` pin also works, `"@effect/platform-node-shared": "4.0.0-rc.108"`
under `overrides` in `package.json` for npm and Bun, and under `overrides` in
`pnpm-workspace.yaml` for pnpm 11, which no longer reads a `pnpm` field from
`package.json`. It is the heavier route. npm does not reconcile a tree that is
already on disk when `overrides` changes: it answers `up to date` and leaves the
drifted copy nested, so an installed project has to delete `node_modules` and
the lockfile (`package-lock.json` or `bun.lock`) and install again.

The only way to learn a new system is to write programs in it. The first program
to write is the same as it has always been: print a greeting.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

// The atom that does the work: schemas and a tag, no code.
export const Greet = Action.make("examples/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})

// The composite: a pure body that names the atom instead of calling it.
export const Greeting = Flow.make("examples/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) => Greet.call(payload)
})

// The implementation is attached separately, where the code can run.
const GreetingLayer = Layer.mergeAll(
  Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)),
  Interpreter.layer(Greeting)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  // Step identity is a derived hash, so the engine needs a Crypto even in memory.
  Layer.provideMerge(NodeCrypto.layer)
)

const program = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
).pipe(Effect.provide(GreetingLayer))

Effect.runPromise(program).then(console.log)
// "Hello, Ada."
```

The engine above keeps its state in the process, which is fine for a first
program and no help in a crash. To survive one, drive the same flow, unchanged,
with `EngineStore.layer` over SQLite. The examples show the wiring.

## Examples

The runnable programs live in [`examples/src`](examples/src), numbered in reading
order. `pnpm run test:examples` runs every one against the real packages: the
durable examples open a real SQLite file, the host example spawns a real process,
and the browser example is bundled by a real bundler.

- `01-define-and-run.ts`: define a typed flow and run it on the in-memory engine
- `02-run-durably.ts`: run a flow on the durable engine and read the journal it wrote
- `03-crash-and-resume.ts`: suspend a run, drop the engine, and resume from durable state
- `04-retry-policy.ts`: retry a flaky action, and read the policy that decides when to stop
- `05-time-travel-fork.ts`: fork a finished run at a journal frame and drive the copy
- `06-time-travel-rewind.ts`: rewind a run to an earlier frame and re-derive a view
- `07-sync-follower.ts`: follow a run's journal from a second process
- `08-host-adapters.ts`: run the same host program against two adapters
- `09-browser-use.ts`: use the library from a browser bundle
- `10-telemetry-export.ts`: export OTLP spans and read the same run three ways
- `11-agent-step.ts`: chain two model-backed agent steps with declared output schemas

## Features

- Schema-typed payloads, successes, and errors.
- One transaction per step.
- Fenced ownership; zombie owners interrupt themselves.
- Durable deferreds, clocks, and queues.
- Retry deadlines survive restarts.
- Content-addressed step keys.
- Grant-checked host access.
- Node, Bun, browser, and test hosts.
- Read-only follower sync.
- Replay, fork, rewind, compensate, recover.
- Layers, not hooks.

## Packages

| Package | Role |
| --- | --- |
| `@smthrs/flows` | Umbrella barrel re-exporting the engine packages below as namespaces; the `platform-*` bundles are deliberately excluded |
| `@smthrs/canonical` | RFC 8785 canonical JSON as an Effect Schema |
| `@smthrs/platform-node` | The Node host bundle: Effect's Node platform services, the Undici transport, and the Node jj adapter |
| `@smthrs/platform-bun` | The same bundle for Bun, over `@effect/platform-bun` |
| `@smthrs/jj` | Jujutsu snapshot, restore, diff, and workspace operations as a host service |
| `@smthrs/sandbox` | Remote `ChildProcessSpawner` implementation and the sandbox liveness probe |
| `@smthrs/platform-browser` | Browser `FileSystem` and `ChildProcessSpawner` over ZenFS and just-bash, plus the `BrowserHost` bundle |
| `@smthrs/journal` | Logical WAL, migrations, projections, redaction, the `OwnerId` fence |
| `@smthrs/run-store` | Run and attempt stores, ownership arbitration, migrations |
| `@smthrs/step-cache` | Sealed step result cache and its migration |
| `@smthrs/artifacts` | Content-addressed artifact store, local and remote |
| `@smthrs/database` | Driver-neutral SQL contract with transactional write retry |
| `@smthrs/capability` | Capability vocabulary and typed permission failures, shared by the kernel and `@smthrs/jj` |
| `@smthrs/kernel` | The closed host service list, capability sets, grants, and permission-decorated host services |
| `@smthrs/crypto` | Strict injected and synchronous SHA-256 |
| `@smthrs/keys` | Canonical flow keys |
| `@smthrs/plan` | The persisted plan: a keyed action graph, its append-only store, and its diff |
| `@smthrs/flow` | Flow definitions, actions, durable primitives, retry policy, and the `FlowRuntime` port |
| `@smthrs/engine` | The runtime that executes flows, plus the RPC and HTTP facades |
| `@smthrs/engine-store` | The durable engine: claims, fences, and persists runs over the journal |
| `@smthrs/sync` | Read-only journal replication for followers |
| `@smthrs/time-travel` | Replay, fork, rewind, compensation, and recovery protocols |
| `@smthrs/agent` | Production agent loop on the durable engine: `AgentSession`, `AgentAction`, `CellPlugin` |
| `@smthrs/cli` | The `smithers` executable and its `NodeControl` composition |
| `@smthrs/control` | Control services, RPC schema, `ControlServer` and `ControlClient`, credentials |
| `@smthrs/gateway` | Gateway wire schemas, projections, session tokens, and the `SuperviseRuntime` port |
| `@smthrs/model` | Schema-first model protocols, routes, streaming, and seat resolution |
| `@smthrs/memory` | Durable cross-run facts, history, notes, and recall |
| `@smthrs/observability` | OTLP wiring, `JournalLogger`, metrics |

`docs/pages/package-structure.mdx` lists every package, including the private
build and testing packages this table omits.

## Compatibility

The release policy freezes this wording, and the README quotes it rather than
summarizing it:

Smithers 1.0.0-rc.0 is a source migration, not a compatible upgrade. It provides no JSX workflow API, no `smthrs/jsx-runtime` or `smthrs/jsx-dev-runtime`, no React reconciler, no `<Workflow>`, `<Task>`, `<Sequence>`, `<Parallel>`, `<Loop>`, `<Ralph>`, `<Branch>`, `<Approval>`, `<Signal>`, `<Timer>`, `<Subflow>`, `<Worktree>`, or `<Saga>` components, no `createSmithers`, `runWorkflow`, `renderFrame`, or `SmithersCtx`, no `smthrs` facade, no 0.x CLI verbs beyond those listed in the 1.0 command table, no 0.x gateway protocol, and no ability to load, resume, or migrate 0.x run databases. No shim, adapter, or compatibility layer will be published. Flows are written against `@smthrs/flow` (`Flow`, `Action`, durable waits, `RetryPolicy`), `@smthrs/engine`, `@smthrs/control`, and Effect `4.0.0-rc.108`, and run on Node.js 22.19.0 or later with local SQLite. Existing 0.x projects migrate their source with the `migrate-smithers-v1` workflow (`smithers migrate`), which rewrites workflows, imports, configuration, scripts, and docs and reports every construct it could not translate. Runtime behavior between 0.x and 1.0 is not equivalent and is not intended to be.

Storage in rc.0 is local SQLite only. PostgreSQL and PGlite are unsupported:
`SMITHERS_BACKEND=pglite|postgres` and `--backend pglite|postgres` exit with
`unsupported_database`.

## Documentation

Full documentation lives at [smithers.sh](https://smithers.sh). The pages are
under [`docs/pages`](docs/pages); `pnpm exec vocs dev` serves the site locally.

`CONTRIBUTING.md` covers the build system, the target graph, and the gates.

## License

MIT
