/**
 * Cancel a run, and watch the cancellation reach everything the run was
 * holding: its linked child, and the operating-system process its step started.
 *
 * Cancellation in this engine is durable, not a flag anybody polls. Interrupting
 * a run writes its terminal transition and, in the SAME transaction, walks the
 * `flows_run_parents` edge table and cancel-requests every linked descendant. A
 * crash cannot therefore leave a cancelled parent over a live child, and a
 * cancellation observed from durable state by a process that never spawned the
 * children still reaches them.
 *
 * Two things follow from that, and this example shows both.
 *
 * **The parent writes a request, not the child's terminal row.** Ownership
 * fencing forbids one run's driver writing state for a run another driver owns,
 * so the child's own driver settles the request at its next boundary. What is
 * atomic with the parent's exit is the REQUEST; the settlement is the child's.
 *
 * **A process is not a fiber.** Interrupting a fiber does nothing to a
 * subprocess it started, so containment is the host's job:
 * `NodeRuntime.layerHost` gives every spawned process its own process group,
 * records it in the durable `ProcessLedger`, and signals then kills the group
 * when the action's scope closes. Cancelling the run closes that scope, which is
 * what makes the group go away.
 */
import { Capability } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Action, Flow, Interpreter, WaitFor } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { dirname } from "node:path"

/** The child's one step: park until somebody answers. */
export const Watch = Flow.make("examples/Watch", {
  payload: { target: Schema.String },
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: () => WaitFor.action.call({ name: "clearance" })
})

/**
 * The parent. `.child()` makes the call a run of its own, and waiting for its
 * result is what records `onParentExit: "cancel"` on it. An attached child
 * exists because something is waiting for it.
 */
export const Deploy = Flow.make("examples/Deploy", {
  payload: { target: Schema.String },
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: (payload: { readonly target: string }) => Watch.child(payload)
})

/** The parent's execution id. Its child derives one from it. */
export const deployRunId = "deploy-1"

/** One run row, as durable state records it after the cancellation. */
export interface RunState {
  readonly runId: string
  readonly status: string
  readonly cancelRequested: boolean
}

/** What the cascade did. */
export interface CascadeSummary {
  /** The parent and the child before anything was cancelled. */
  readonly before: ReadonlyArray<RunState>
  /** The same two runs after the parent was interrupted. */
  readonly after: ReadonlyArray<RunState>
  /** The runs the interruption cascaded to, as the parent journalled them. */
  readonly cascadedTo: ReadonlyArray<string>
  /** The child spawns the parent recorded as effect boundaries. */
  readonly spawned: ReadonlyArray<string>
}

/** What the containment half observed. */
export interface ContainmentSummary {
  /** The process group the cancelled step started. */
  readonly pgid: number
  /** Whether that group was alive while the step was running. */
  readonly aliveDuringRun: boolean
  /** Whether it survived the cancellation, which it must not. */
  readonly survivedCancel: boolean
}

const stateOf = (row: {
  readonly runId: string
  readonly status: string
  readonly cancelRequestedAtMs: number | null
}): RunState => ({
  runId: row.runId,
  status: row.status,
  cancelRequested: row.cancelRequestedAtMs !== null
})

/** The engine, on the real Node host, with permission to spawn. */
const host = <Registered, RegistrationRequirements>(
  filename: string,
  hostId: string,
  registrations: Layer.Layer<Registered, never, RegistrationRequirements>
) =>
  NodeRuntime.layerHost(
    {
      filename,
      workspaceRoot: dirname(filename),
      owner: { hostId },
      // No signal handlers: the example is the one deciding when things stop.
      signals: [],
      rules: [
        new Capability.Permission.Rule({
          effect: "allow",
          pattern: new Capability.Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
        })
      ]
    },
    registrations
  )

/** Waits until `read` answers `true`, or gives up after `budgetMs`. */
const until = (
  read: Effect.Effect<boolean>,
  budgetMs: number
): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (yield* read) return true
      yield* Effect.sleep("20 millis")
    }
    return yield* read
  })

/**
 * Starts a parent whose child is parked, cancels the parent, and reads both run
 * rows back out of durable state.
 */
export const cascade = (filename: string): Effect.Effect<CascadeSummary> =>
  Effect.gen(function*() {
    const registrations = Layer.mergeAll(
      WaitFor.layer,
      Interpreter.layer(Deploy),
      Interpreter.layer(Watch)
    ).pipe(Layer.provideMerge(Action.layerImplementations))

    return yield* Effect.scoped(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState

        // The parent starts, the child starts, and the child parks. `execute`
        // returns while both are still open, which is the state a cancellation
        // has to be able to reach.
        yield* Deploy.execute({ target: "server" }, { executionId: deployRunId, discard: true })
        const edges = yield* until(
          Effect.map(state.runChildren(deployRunId), (found) => found.length > 0),
          5_000
        ).pipe(Effect.andThen(state.runChildren(deployRunId)))
        const childId = edges[0]?.childId ?? "no-child"
        const before = yield* Effect.forEach([deployRunId, childId], (runId) =>
          Effect.map(runs.get(runId), stateOf))

        // The cancellation. `interrupt` is the durable path: the terminal
        // transition and the descendants' cancel requests commit together.
        yield* Deploy.interrupt(deployRunId)
        yield* until(
          Effect.map(runs.get(deployRunId), (row) => row.status === "cancelled").pipe(Effect.orDie),
          5_000
        )
        yield* until(
          Effect.map(
            runs.get(childId),
            (row) => row.cancelRequestedAtMs !== null || row.status === "cancelled"
          ).pipe(Effect.orDie),
          5_000
        )
        const after = yield* Effect.forEach([deployRunId, childId], (runId) =>
          Effect.map(runs.get(runId), stateOf))

        // The parent journalled what it decided about each linked child.
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: deployRunId as JournalEvent.RunId, limit: 500 })
        // The interruption record names every run the cascade reached. It is
        // written in the same transaction as the parent's terminal row, which
        // is what makes "cancelled parent, live child" unrepresentable.
        const cascadedTo = page.entries
          .filter((entry) => entry.eventType === "flows.engine.interrupted")
          .flatMap((entry) => (entry.payload as { readonly cascadedTo?: ReadonlyArray<string> }).cascadedTo ?? [])
        // The spawn itself is a recorded effect boundary, so the lineage is
        // auditable rather than inferred from the edge table alone.
        const spawned = page.entries
          .filter((entry) => entry.eventType === "flows.time-travel.effect-boundary")
          .map((entry) => (entry.payload as { readonly effect?: { readonly kind?: string } }).effect?.kind)
          .filter((kind): kind is string => kind !== undefined)

        return { before, after, cascadedTo, spawned } satisfies CascadeSummary
      }).pipe(Effect.provide(host(filename, "examples-cancel", registrations)))
    )
  }).pipe(Effect.orDie)

/** Whether a process group still exists. */
const groupIsAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

/** The step that opens a process group and then waits for it. */
export const Hold = Action.make("examples/HoldProcess", {
  payload: { seconds: Schema.Number },
  success: Schema.String
})

/** The flow that holds a real process group open while it is cancelled. */
export const Occupy = Flow.make("examples/Occupy", {
  payload: { seconds: Schema.Number },
  success: Schema.String,
  body: (payload: { readonly seconds: number }) => Hold.call(payload)
})

/** The occupying run's execution id. */
export const occupyRunId = "occupy-1"

/**
 * Starts a run whose step holds a real process group, cancels it, and checks
 * that the group is gone.
 */
export const contained = (filename: string): Effect.Effect<ContainmentSummary> =>
  Effect.gen(function*() {
    let pgid = 0
    let started = false

    const hold = Hold.toLayer(({ seconds }) =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        // Two processes so the group outlives anything short of a group signal,
        // which is exactly what an unconstrained kill would miss.
        const handle = yield* Effect.orDie(
          spawner.spawn(ChildProcess.make("sh", ["-c", `sleep ${seconds} & sleep ${seconds}`]))
        )
        pgid = handle.pid as number
        started = true
        yield* Effect.orDie(handle.exitCode)
        return "finished"
      })
    )

    const registrations = Layer.mergeAll(hold, Interpreter.layer(Occupy)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    )

    const aliveDuringRun = yield* Effect.scoped(
      Effect.gen(function*() {
        // The run holds the group open, so it is started in the background and
        // cancelled while its step is still running.
        const running = yield* Effect.forkChild(
          Occupy.execute({ seconds: 300 }, { executionId: occupyRunId })
        )
        yield* until(Effect.sync(() => started && groupIsAlive(pgid)), 10_000)
        const alive = groupIsAlive(pgid)
        yield* Occupy.interrupt(occupyRunId)
        yield* Fiber.await(running)
        return alive
      }).pipe(Effect.provide(host(filename, "examples-contained", registrations)))
    )

    // The scope is closed: the spawner's finalizer has signalled and killed the
    // group, and the reaper had nothing left to do.
    const survivedCancel = yield* until(Effect.sync(() => !groupIsAlive(pgid)), 10_000).pipe(
      Effect.map((gone) => !gone)
    )

    return { pgid, aliveDuringRun, survivedCancel } satisfies ContainmentSummary
  }).pipe(Effect.orDie)
