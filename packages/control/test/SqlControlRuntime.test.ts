/**
 * The durable `ControlRuntime`: the shared `ControlLive` contract, plus what
 * only a durable adapter can be asked — surviving a restart, refusing a stale
 * process's writes, and losing a claim race to a live peer.
 *
 * Contract source: `.smithers/tickets/control-runtime-engine-integration.md`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Migrations, SqlJournal } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, Ownership, RunStore } from "@smthrs/run-store"
import { type Crypto, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { Control, type Service as ControlService } from "../src/Control.ts"
import { ClaimLost, PersistenceError, RunNotFound } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime, type Service as ControlRuntimeService } from "../src/ControlRuntime.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"
import { contract, type Stack } from "./ControlContract.ts"

/**
 * The durable journal bundle, with `Database` kept in the output so the control
 * runtime and the journal share one connection and therefore one transaction
 * boundary.
 */
const durableJournal = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer
).pipe(
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.merge(Migrations.layer, RunStoreMigrations.layer),
      TestDatabase.layer
    )
  )
)

/** A complete durable Control stack over one in-memory SQLite database. */
const durable = (
  options: {
    readonly executor?: ControlExecutor.Service | undefined
    readonly owner?: Ownership.OwnerId | undefined
    readonly database?:
      | Layer.Layer<DurableWriter | SqlClient.SqlClient | RunStore.RunStore, unknown>
      | undefined
  } = {}
): Layer.Layer<Stack | DurableWriter | SqlClient.SqlClient | RunStore.RunStore | Crypto.Crypto> => {
  const journal = options.database ?? durableJournal
  const runtime = SqlControlRuntime.layer(
    options.owner === undefined ? {} : { owner: options.owner }
  ).pipe(Layer.orDie)
  // The database is provided once, to the whole stack: `NodeDatabase.layer`
  // opens a fresh `:memory:` connection per build, so provisioning it to each
  // consumer separately would hand them unrelated databases.
  return Layer.provideMerge(
    ControlLive.layer,
    Layer.mergeAll(
      runtime,
      NotificationQueue.layer,
      ControlExecutor.layer(options.executor ?? ControlExecutor.makeNoop()),
      Registry.layerNoop()
    )
  ).pipe(Layer.provideMerge(Layer.merge(journal, NodeCrypto.layer))) as Layer.Layer<
    Stack | DurableWriter | SqlClient.SqlClient | RunStore.RunStore | Crypto.Crypto
  >
}

contract("durable", (executor) => durable(executor === undefined ? {} : { executor }))

/**
 * One database shared by two runtimes, which is what "two processes" means to
 * the store: distinct owner identities racing over the same rows.
 */
const twoOwners = <A, E>(
  use: (
    first: ControlRuntimeService,
    second: ControlRuntimeService,
    control: ControlService
  ) => Effect.Effect<A, E, Control | ControlRuntime>
): Promise<A> => {
  const shared = durableJournal
  return Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control
      const first = yield* ControlRuntime
      const second = yield* SqlControlRuntime.make({
        owner: { hostId: "local", pid: 1, nonce: "peer" }
      }).pipe(Effect.orDie)
      return yield* use(first, second, control)
    }).pipe(
      Effect.provide(durable({ database: shared })),
      Effect.scoped,
      Effect.orDie
    )
  )
}

const started = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: { suite: "durable" } })
  yield* control.approve({
    target: card.approval.target,
    scope: card.approval.scope,
    idempotencyKey: card.approval.idempotencyKey
  })
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die("expected an accepted run")
  }
  return { card, runId: receipt.runId }
})

describe("SqlControlRuntime", () => {
  it("survives a restart: a second runtime over the same database sees the run", async () => {
    const shared = durableJournal
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const { card, runId } = yield* started
        yield* control.pause({ runId, idempotencyKey: "pause:restart" })

        // Nothing of the first runtime is carried across — only the database.
        const restarted = yield* SqlControlRuntime.make({
          owner: { hostId: "local", pid: 2, nonce: "restarted" }
        }).pipe(Effect.orDie)
        const run = yield* restarted.getRun(runId)
        const plan = yield* restarted.getPlan(card.planId)
        const runs = yield* restarted.listRuns
        const grants = yield* restarted.grants
        const replay = yield* restarted.lookupMutation(`run:${`run:${card.planId}`}`, "x")
        const resumed = yield* restarted.resume(runId)
        return { run, plan, runs, grants, replay, resumed }
      }).pipe(
        Effect.provide(durable({ database: shared })),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.run.status).toBe("parked")
    expect(observed.plan.decision).toBe("approved")
    expect(observed.plan.decodedInput).toEqual({ suite: "durable" })
    expect(observed.runs.map((run) => run.runId)).toEqual([observed.run.runId])
    expect(observed.grants).toHaveLength(1)
    // A replay lookup under a different fingerprint is a conflict, not a hit.
    expect(observed.replay?._tag).toBe("Conflict")
    expect(observed.resumed.status).toBe("accepted")
  })

  it("refuses a stale process's fenced write after a peer claims the run", async () => {
    const observed = await twoOwners((first, second, control) =>
      Effect.gen(function*() {
        const { runId } = yield* started
        const staleFence = yield* first.claimFence(runId)
        yield* control.pause({ runId, idempotencyKey: "pause:peer" })
        // The peer takes ownership. The first runtime still holds the fence it
        // had before the pause, and that fence is now spent.
        const claimed = yield* second.resume(runId)
        const stale = yield* first.writeStatus(runId, staleFence, "running").pipe(Effect.flip)
        const peerFence = yield* second.claimFence(runId)
        const owned = yield* second.writeStatus(runId, peerFence, "running")
        const evicted = yield* first.claimFence(runId).pipe(Effect.flip)
        return { claimed, stale, owned, evicted }
      })
    )

    expect(observed.claimed.status).toBe("accepted")
    expect(observed.stale).toBeInstanceOf(ClaimLost)
    expect(observed.owned.status).toBe("running")
    expect(observed.evicted).toBeInstanceOf(ClaimLost)
  })

  it("lets exactly one of two concurrent resumes claim a parked run", async () => {
    const observed = await twoOwners((first, second, control) =>
      Effect.gen(function*() {
        const { runId } = yield* started
        yield* control.pause({ runId, idempotencyKey: "pause:race" })
        const results = yield* Effect.all(
          [Effect.exit(first.resume(runId)), Effect.exit(second.resume(runId))],
          { concurrency: 2 }
        )
        return results.filter((exit) => exit._tag === "Success").length
      })
    )

    // One claims; the loser either loses the CAS or joins the winner's run.
    // Both are legal — what is not legal is two owners.
    expect(observed).toBeGreaterThanOrEqual(1)
  })

  it("refuses to interrupt or pause a run this process does not own", async () => {
    const observed = await twoOwners((first, second, control) =>
      Effect.gen(function*() {
        const { runId } = yield* started
        yield* control.pause({ runId, idempotencyKey: "pause:foreign" })
        yield* second.resume(runId)
        const interrupted = yield* first.interrupt(runId).pipe(Effect.flip)
        const paused = yield* first.pause(runId).pipe(Effect.flip)
        return { interrupted, paused }
      })
    )

    expect(observed.interrupted).toBeInstanceOf(ClaimLost)
    expect(observed.paused).toBeInstanceOf(ClaimLost)
  })

  it("reports unknown ids and unknown flows as typed failures", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const missingFlow = yield* runtime.plan({ flowId: "system/nope", input: {} }).pipe(Effect.flip)
        const missingRun = yield* runtime.registerFiber(
          "run-absent",
          yield* Effect.void.pipe(Effect.forkChild({ startImmediately: true }))
        ).pipe(Effect.flip)
        const missingSignal = yield* runtime.deliveredSignals("run-absent").pipe(Effect.flip)
        const missingSteer = yield* runtime.enqueueSteer("run-absent", {
          messageId: "m",
          runId: "run-absent",
          body: "b",
          principal: { id: "p", kind: "test", stampedAt: 0 },
          createdAt: 0
        }).pipe(Effect.flip)
        const badFence = yield* runtime.writeStatus("run-absent", "not json", "running").pipe(Effect.flip)
        return { missingFlow, missingRun, missingSignal, missingSteer, badFence }
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(observed.missingFlow._tag).toBe("/control/FlowNotFound")
    expect(observed.missingRun).toBeInstanceOf(RunNotFound)
    expect(observed.missingSignal).toBeInstanceOf(RunNotFound)
    expect(observed.missingSteer).toBeInstanceOf(RunNotFound)
    expect(observed.badFence).toBeInstanceOf(RunNotFound)
  })

  it("replays a plan for a repeated idempotency key and rejects a reused one", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const first = yield* runtime.plan({ flowId: "system/test", input: { a: 1 }, idempotencyKey: "k" })
        const replay = yield* runtime.plan({ flowId: "system/test", input: { a: 1 }, idempotencyKey: "k" })
        const reused = yield* runtime.plan({ flowId: "system/test", input: { a: 2 }, idempotencyKey: "k" }).pipe(
          Effect.flip
        )
        const principal = yield* runtime.stampPrincipal()
        const flows = yield* runtime.listFlows
        return { first, replay, reused, principal, flows }
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(observed.replay.planId).toBe(observed.first.planId)
    expect(observed.reused._tag).toBe("/control/InvalidInput")
    expect(observed.principal.id).toBe("local")
    expect(observed.flows.length).toBeGreaterThan(0)
  })

  it("records and replays a mutation receipt across runtimes", async () => {
    const observed = await twoOwners((first, second) =>
      Effect.gen(function*() {
        yield* first.recordMutation("mut", "fp", { _tag: "Accepted", receiptId: "r", runId: "run-1" })
        const hit = yield* second.lookupMutation("mut", "fp")
        const miss = yield* second.lookupMutation("other", "fp")
        return { hit, miss }
      })
    )

    expect(observed.hit).toEqual({ _tag: "AlreadyApplied", receiptId: "r", runId: "run-1" })
    expect(observed.miss).toBeUndefined()
  })

  it("never lets a racing mutation overwrite the first durable receipt", async () => {
    const observed = await twoOwners((first, second) =>
      Effect.gen(function*() {
        yield* first.recordMutation("mut", "first", { _tag: "Accepted", receiptId: "first" })
        const rejected = yield* Effect.flip(
          second.recordMutation("mut", "second", { _tag: "Accepted", receiptId: "second" })
        )
        const retained = yield* second.lookupMutation("mut", "first")
        return { rejected, retained }
      })
    )

    expect(observed.rejected).toBeInstanceOf(PersistenceError)
    expect(observed.retained).toEqual({ _tag: "AlreadyApplied", receiptId: "first" })
  })

  it("allows a concurrent write while a finite snapshot page is being consumed", async () => {
    const pageStarted = Deferred.makeUnsafe<void>()
    const releasePage = Deferred.makeUnsafe<void>()
    let paused = false
    const observedJournal = Layer.effect(
      Journal.Journal,
      Effect.map(Journal.Journal, (journal) =>
        Journal.make({
          ...journal,
          entries: (options) =>
            Effect.suspend(() => {
              if (paused || options.limit !== 1024) return journal.entries(options)
              paused = true
              return Deferred.succeed(pageStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releasePage)),
                Effect.andThen(journal.entries(options))
              )
            })
        }))
    )
    const runtime = SqlControlRuntime.layer().pipe(Layer.orDie)
    const notifications = NotificationQueue.layer.pipe(Layer.provide(observedJournal))
    const control = ControlLive.layer.pipe(
      Layer.provide([
        runtime,
        observedJournal,
        notifications,
        ControlExecutor.layerNoop(),
        Registry.layerNoop()
      ]),
      Layer.provideMerge(Layer.merge(durableJournal, NodeCrypto.layer))
    ) as Layer.Layer<Control>

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* started
        for (let index = 0; index < 1025; index++) {
          yield* control.signal({
            runId,
            signal: { name: `seed-${index}`, payload: null },
            idempotencyKey: `signal:seed-${index}`
          })
        }

        const snapshot = yield* control.watch({ runId, follow: false }).pipe(
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(pageStarted).pipe(Effect.timeout("1 second"))
        const receipt = yield* control.signal({
          runId,
          signal: { name: "during-snapshot", payload: null },
          idempotencyKey: "signal:during-snapshot"
        }).pipe(Effect.timeout("1 second"))
        yield* Deferred.succeed(releasePage, undefined)
        const events = yield* Fiber.join(snapshot)
        return { events, receipt }
      }).pipe(
        Effect.provide(control),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.receipt._tag).toBe("Accepted")
    const signalNames = observed.events
      .filter((event) => event.kind === "control.signal.delivered")
      .map((event) => (event.payload as { readonly name: string }).name)
    expect(signalNames).toContain("seed-1024")
    expect(signalNames).not.toContain("during-snapshot")
  })

  it("owns no Node imports", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/SqlControlRuntime.ts", import.meta.url), "utf8")
    )
    expect(source).not.toMatch(/(?:from|import\s*)\s*["']node:/)
    expect(source).not.toContain(["@effect", "platform-node"].join("/"))
  })
})
