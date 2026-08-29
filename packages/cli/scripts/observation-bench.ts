/**
 * Times the workspace measurement under the CLI's own compositions.
 *
 * Three numbers on one tree:
 *
 * - `guarded` — the observer over `NodeControl.layerGuardedPlatform`, which is
 *   what `1a5d6214c` shipped. Every `stat` is one authorized host call, and on
 *   Node that is one descriptor-relative helper process per path. Sample it
 *   with a small `maxPaths` rather than waiting out a whole checkout.
 * - `host` — the observer over `NodeControl.layerHostPlatform`, which is what
 *   the executor composes today. Taken twice, because a frame takes the
 *   measurement twice.
 * - `boundary` — one `workspace-close`, the way `CellTurn` takes it at the end
 *   of every frame: the same measurement through `FlowEngineLike.record`. The
 *   flow engine underneath is the in-memory one, so the number is the
 *   measurement plus the port's own boundary work, without SQLite.
 *
 * Usage: `bun packages/cli/scripts/observation-bench.ts [root] [maxPaths] [which]`
 * where `which` is `both` (default), `guarded`, or `host`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { Engine, Flow, FlowRuntime, Plan } from "@smthrs/flows"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { Effect, FileSystem, Layer, Schema, Scope, Stream } from "effect"
import { resolve } from "node:path"
import * as NodeControl from "../src/NodeControl.ts"

const root = resolve(process.argv[2] ?? "evals/swebench/work/django__django-16612")
const maxPaths = Number(process.argv[3] ?? 50_000)
const which = process.argv[4] ?? "both"

const report = (label: string, elapsed: number, paths: number, complete: boolean): void =>
  console.log(
    `${label}: ${elapsed.toFixed(1)} ms for ${paths} paths (${
      (elapsed / Math.max(paths, 1)).toFixed(3)
    } ms/path, complete=${complete})`
  )

const walk = (label: string, platform: Layer.Layer<FileSystem.FileSystem>) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const started = performance.now()
    const observation = yield* WorkspaceObservation.observe(fileSystem, root, { maxPaths })
    report(label, performance.now() - started, observation.paths, observation.complete)
  }).pipe(Effect.provide(platform), Effect.scoped)

/** The port requires a model and a route to exist; a `workspace-close` calls neither. */
const inertModel: Model.Model = Model.make({ stream: () => Stream.empty })
const inertRoute: FlowEngineLike.RouteResolver = {
  prepare: () => Effect.fail(new ModelError({ code: "invalid_request", message: "the bench calls no model" }))
}

const benchFlow = Flow.make("cli/observation-bench", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Plan.Node.succeed(undefined)
})

const boundary = Effect.gen(function*() {
  const engine = yield* FlowRuntime.FlowRuntime
  const scope = yield* Effect.scope
  yield* engine.register(benchFlow, () =>
    Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: inertModel, route: inertRoute })
      const started = performance.now()
      const observed = yield* port.record({
        name: "workspace-close",
        identity: { session: "observation-bench", frame: 0, boundary: "bench" },
        success: Schema.Option(EngineLike.Observation),
        execute: port.observe
      })
      const elapsed = performance.now() - started
      report(
        "boundary   ",
        elapsed,
        observed._tag === "Some" ? observed.value.paths : 0,
        observed._tag === "Some" ? observed.value.complete : false
      )
    })).pipe(Scope.provide(scope))
  yield* engine.execute(benchFlow, { executionId: "observation-bench-1", payload: {} })
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      Engine.FlowEngine.layerMemory,
      NodeCrypto.layer,
      WorkspaceObservation.layer(root, { maxPaths }).pipe(Layer.provide(NodeControl.layerHostPlatform))
    )
  ),
  Effect.scoped
)

await Effect.runPromise(
  Effect.gen(function*() {
    if (which !== "host") yield* walk("guarded    ", NodeControl.layerGuardedPlatform(root))
    if (which !== "guarded") {
      yield* walk("host (open) ", NodeControl.layerHostPlatform)
      yield* walk("host (close)", NodeControl.layerHostPlatform)
      yield* boundary
    }
  })
)
