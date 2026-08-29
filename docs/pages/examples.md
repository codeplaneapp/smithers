---
description: "Eleven runnable programs under examples/src, each paired with a test that runs it against the real packages."
---

# Examples

Eleven programs under `examples/src`, each one paired with a test under `examples/test` that runs it against the real packages. Nothing in this directory is mocked: the durable examples open a real SQLite file, the host example spawns a real process, and the browser example is bundled by a real bundler.

```sh
pnpm install
pnpm run test:examples
```

The suite is a gate, so a snippet that stops compiling or stops producing the documented answer fails the build rather than drifting quietly.

## The programs

| File | Shows | The assertion that matters |
| --- | --- | --- |
| [`01-define-and-run.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/01-define-and-run.ts) | the shortest complete program: `Action.make` and its `toLayer`, a `Flow.make` body that names it, `Interpreter.layer`, `FlowEngine.layerMemory` | the flow returns `Hello, Ada.` |
| [`02-run-durably.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/02-run-durably.ts) | the same flow body on `EngineStore` over SQLite, then reading the journal it wrote | the run produces its result and the journal holds lifecycle entries |
| [`03-crash-and-resume.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/03-crash-and-resume.ts) | suspending on a `DurableDeferred`, dropping the engine, and resuming from durable state | the suspended step's implementation runs more than once and the sealed action in front of the suspension dispatches exactly once |
| [`04-retry-policy.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/04-retry-policy.ts) | `RetryPolicy` as inspectable data, and `Action.retry` as the runtime side | the ladder is `[100, 200, 400, null]`, a non-retryable tag gives up, and the flaky action succeeds on dispatch three |
| [`05-time-travel-fork.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/05-time-travel-fork.ts) | `TimeTravel.fork` at a position, copying executable state and attempts into a new run | the fork returns the parent's answer with one total dispatch, because the sealed cache key replays |
| [`06-time-travel-rewind.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/06-time-travel-rewind.ts) | `TimeTravel.inspect` folding entries at a frame, and `TimeTravel.rewind` truncating the suffix | the derived total is the value at the frame, the suffix past it is archived, fewer entries remain than the run wrote, and the audit completes |
| [`07-sync-follower.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/07-sync-follower.ts) | a follower catching up on durable history and then following live commits | the first two entries are history and the third arrived after the subscription opened |
| [`08-host-adapters.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/08-host-adapters.ts) | one adapter-neutral program run on `TestHost` and on `NodeHost` | the scripted shell and the real spawned process both answer |
| [`09-browser-use.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/09-browser-use.ts) | importing only browser-safe entry points | the program runs, and esbuild bundles the file with `platform: "browser"` |
| [`10-telemetry-export.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/10-telemetry-export.ts) | adding `Otlp.layerFetch` to the durable composition from `02`, then reading the run three ways: the OTLP export, the journal, and a tagged metric view | the collector receives spans from the flow lifecycle down to `sql.execute`, the journal holds the lifecycle events, and `EngineStoreMetrics.dispatch.Success` reads `1` |
| [`11-agent-step.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/11-agent-step.ts) | `@smthrs/agent/AgentAction`'s `make`: a model-backed step with a declared output schema, chained into a second one, against a model supplied by a scripted `SeatResolver` | the research step's answer decodes to `{ summary, keyPoints }` and the article step returns `wordCount` `12` |
| [`32-intervene.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/32-intervene.ts) | `@smthrs/patterns/Intervene` over `@smthrs/std`: a read, a proposal, a write gated by `WithApproval`, and a report, planned as a graph and run on a real temp directory | the approved run rewrites the file, the dry run leaves it alone and plans no write at all, and a denial fails on the schema channel before the edit |

## Reading them in order

The first three build on each other. `01` shows what the two nouns are with nothing durable underneath: an `Action` declaration whose implementation arrives as a layer, and a `Flow` whose body names it. `02` swaps `FlowEngine.layerMemory` for the durable engine and changes nothing else in the flow body, which is the point of the encoded seam. `03` is the reason durability exists: the run suspends waiting for an approval that has not arrived, the engine is discarded, a second engine over the same file attaches the same implementation, and the run finishes without re-dispatching the work it already recorded.

`04` separates policy from execution. The backoff ladder is computed from the policy value with no engine in scope, which is how a deployment can review a retry configuration before shipping it.

`05` and `06` are the two halves of time travel, and both reach them through the one injectable `TimeTravel` service. Fork copies a prefix forward; rewind truncates a suffix away. `06` also shows the read-only side, `inspect`, which folds committed entries through a reducer and never runs a flow body.

`07`, `08`, and `09` cover the seams around the engine rather than the engine itself: replicating history to a second process, running one program on two host adapters, and staying inside the browser-safe entry points.

`10` is `02` plus telemetry. The flow body and the engine layers do not change; providing `Otlp.layerFetch` is the entire wiring, and the example reads the same run through the export, through `Journal.entries`, and through a tagged metric view with `Metric.value`. [Telemetry](/telemetry) documents the layer; [Observability](/observability) tables the spans it exports.

`11` is the agent seam. `AgentAction.make` declares a model call as an ordinary action, with the same tag, the same `.call()`, and the same plan node, and ships the implementation with it, so the author writes a seat, a system prompt, a prompt built from the payload, and an `output` schema instead of a `toLayer`. The implementation resolves the declared seat through the `SeatResolver` service and runs one loop of the `Agent` service inside the enclosing execution. The schema is rendered into the run's teaching and enforced on the way out, which is why the second step reads `research.summary` as a `string`. The example provides a `SeatResolver` that answers with a scripted model, so it runs in CI with no API key.

## The shared durable layer

`examples/src/durable-layer.ts` composes what `EngineStore.layer` needs: the journal and its three stores, the durable deferred and clock state, a kernel `Jj`, and a `StepBoundary`, all over one SQLite file. Every persistence example reuses it, which is also why a restart in one example reads the rows a previous phase wrote.

The `Jj` in that layer is a stub that records nothing. The examples use sealed actions, so the engine never needs a real snapshot, and a stub keeps the composition honest without requiring a `jj` binary on the machine. The storage and engine part of what these examples once assembled by hand now ships as the `@smthrs/flows/NodeRuntime` subpath, and `durable-layer.ts` builds on it. The host part is still assembled here: `NodeRuntime` takes `StepBoundary` and `WorkspaceSandbox` as arguments and leaves `Jj`, Effect `FileSystem`, and Effect `Crypto` as requirements the example supplies.

## Reading next

[Public API](/api/flows) documents every export these programs use. [Public API tests](/api-tests) shows where the same behaviors are pinned inside the packages themselves.
