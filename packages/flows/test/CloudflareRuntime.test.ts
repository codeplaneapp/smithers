/**
 * The Durable Object composition, booted end to end over one object's SQLite.
 *
 * `src/CloudflareRuntime.ts` is what a Durable Object's constructor calls to
 * stand a durable engine up, and every claim its doc comment makes is an
 * ordering claim: migrations finish before a store is built, the engine is
 * built over those stores, and `registerFlows` finishes before the composed
 * services are exposed. None of that is observable from a type, so this suite
 * drives the module the way an object does — one storage handle held for the
 * object's lifetime, two scopes over it, and the storage read back directly
 * rather than through a store.
 *
 * The storage is `@smthrs/database/test/DurableObjectStorageFake`, which runs
 * the platform's synchronous `exec` surface over `node:sqlite`. The driver's
 * own suite runs the shared write contract against it and, behind an env var,
 * against real workerd; this suite is about the composition above the driver.
 *
 * The two scopes are the journey. Scope one migrates, registers, runs a flow
 * to completion, and parks a second flow on a durable deferred. Its closure is
 * the shutdown path — the module installs no handlers. Scope two is a fresh
 * incarnation of the *same object*: it registers the flow again, and the
 * registration sweep is what has to notice the completed deferred and drive
 * the parked run home. That is the property that matters on Workers, where an
 * object is evicted and reconstructed between requests.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import * as DurableObjectStorageFake from "@smthrs/database/test/DurableObjectStorageFake"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { createHash, webcrypto } from "node:crypto"
import * as CloudflareRuntime from "../src/CloudflareRuntime.ts"
import {
  Action,
  DurableDeferred,
  EngineStore as EngineStorePackage,
  Flow,
  FlowRuntime,
  Interpreter,
  Kernel,
  RunStore as RunStorePackage
} from "../src/index.ts"

const { StepBoundary, WorkspaceSandbox } = EngineStorePackage
const { RunStore } = RunStorePackage
const { Jj } = Kernel

/** One Durable Object's storage, held across every incarnation below. */
const storage = DurableObjectStorageFake.make()

afterAll(() => storage.close())

/** SHA-256 and random bytes; on Workers these come from the same web crypto. */
const hostCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => webcrypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.succeed(
        new Uint8Array(createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest())
      )
  })
)

/** No jj in a Durable Object; the flows below take no compensable snapshot. */
const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "cloudflare-runtime-gate" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * The two execution seams the composition leaves to the caller. Both are the
 * filesystem-free variants, which is the point: `CloudflareRuntime` provides
 * no `Workspace` and no local artifact store, because a Durable Object has no
 * filesystem to put them on.
 */
const memorySandbox = Layer.unwrap(
  Effect.map(WorkspaceSandbox.makeMemory(), (sandbox) => WorkspaceSandbox.layer(sandbox.service))
).pipe(Layer.provide(hostCrypto), Layer.orDie)

const host = Layer.merge(hostCrypto, stubJj)

/** Every dispatch the journey makes, so a replayed one is visible as a count. */
const dispatches = { assess: 0, tally: 0 }

const Approval = DurableDeferred.make("flows/cloudflare/approval", {
  success: Schema.String
})

const Assess = Action.make("flows/cloudflare/assess", {
  payload: { document: Schema.String },
  success: Schema.String
})

const Review = Flow.make("flows/cloudflare/review", {
  payload: { document: Schema.String },
  success: Schema.String,
  body: (payload) => Assess.call(payload)
})

const Tally = Action.make("flows/cloudflare/tally", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Count = Flow.make("flows/cloudflare/count", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Tally.call({ value })
})

const assess = ({ document }: { readonly document: string }) =>
  Effect.gen(function*() {
    dispatches.assess += 1
    const verdict = yield* DurableDeferred.await(Approval)
    return `${document}:${verdict}`
  })

const tally = ({ value }: { readonly value: number }) =>
  Effect.sync(() => {
    dispatches.tally += 1
    return value * 2
  })

const registerFlows = Layer.mergeAll(Interpreter.layer(Review), Interpreter.layer(Count)).pipe(
  Layer.provideMerge(Layer.mergeAll(Assess.toLayer(assess), Tally.toLayer(tally))),
  Layer.provideMerge(Action.layerImplementations)
)

const options = (hostId: string) => ({
  storage,
  owner: { hostId },
  // One object owns its storage, so no previously recorded owner is alive.
  isAlive: () => Effect.succeed(false)
})

/** One incarnation of the object's runtime, with its flows registered. */
const incarnation = (hostId: string) =>
  CloudflareRuntime.layer(
    options(hostId),
    StepBoundary.layerTest(),
    memorySandbox,
    registerFlows
  ).pipe(Layer.provide(host))

/** Reads the object's SQLite back directly, not through a store. */
const readBack = (query: string): Array<Array<unknown>> => Array.from(storage.sql.exec(query).raw())

/** The value a settled poll answered with, and `undefined` while it has none. */
const completedValue = (result: Option.Option<Flow.Result<unknown, unknown>>): unknown =>
  Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)
    ? result.value.exit.value
    : undefined

describe("the Durable Object composition", () => {
  it("refuses an unusable configuration before it opens anything", () => {
    // Validation is eager: `layer` builds the composition when it is CALLED,
    // so an object constructed without an id fails at wiring time.
    expect(() =>
      CloudflareRuntime.layer(
        { storage, owner: { hostId: "" }, isAlive: () => Effect.succeed(false) },
        StepBoundary.layerTest(),
        memorySandbox,
        Layer.empty
      )
    ).toThrow()
    // Nothing above may have migrated the storage the journey below owns.
    expect(readBack("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([])
  })

  it("migrates, runs, is evicted, and resumes a parked run over one object", async () => {
    // ----------------------------------------------------------------- scope 1
    const first = await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const value = yield* Count.execute({ value: 21 }, { executionId: "cf-count" })
        yield* Review.execute({ document: "rfc" }, { executionId: "cf-review", discard: true })
        return {
          count: yield* runs.get("cf-count"),
          review: yield* runs.get("cf-review"),
          value
        }
      }).pipe(Effect.provide(incarnation("cf-a")), Effect.provide(hostCrypto), Effect.scoped)
    )

    expect(first.value).toBe(42)
    expect(first.count.status).toBe("completed")
    // The parked run released its claim, which is what makes it reclaimable
    // by the next incarnation of the object.
    expect(first.review.status).toBe("suspended")
    expect(first.review.owner).toBeNull()
    expect(dispatches).toEqual({ assess: 1, tally: 1 })

    // Migrations ran against the object's own SQLite, and the state is really
    // there — read back through `exec`, not through a store.
    expect(readBack("SELECT run_id, status FROM flows_runs ORDER BY run_id")).toEqual([
      ["cf-count", "completed"],
      ["cf-review", "suspended"]
    ])
    expect(readBack("SELECT COUNT(*) FROM flows_deferred_completions")).toEqual([[0]])

    // ----------------------------------------------------------------- scope 2
    // The object was evicted and reconstructed. The same storage comes back,
    // the flow is registered again, and the sweep that registration arms is
    // what has to notice the completed deferred and finish the parked run.
    const second = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.deferredDone(Approval, {
          flowName: Review._tag,
          executionId: "cf-review",
          deferredName: Approval.name,
          exit: Exit.succeed("approved")
        })
        const runs = yield* RunStore.RunStore
        let row = yield* runs.get("cf-review")
        for (let attempt = 0; attempt < 200 && row.status === "suspended"; attempt++) {
          yield* Effect.sleep("25 millis")
          row = yield* runs.get("cf-review")
        }
        return {
          replayed: yield* Count.execute({ value: 21 }, { executionId: "cf-count" }),
          result: yield* Review.poll("cf-review"),
          row
        }
      }).pipe(Effect.provide(incarnation("cf-b")), Effect.provide(hostCrypto), Effect.scoped)
    )

    expect(second.row.status).toBe("completed")
    expect(completedValue(second.result)).toBe("rfc:approved")
    // The settled run from scope one is read back, not re-executed.
    expect(second.replayed).toBe(42)
    expect(dispatches.tally).toBe(1)
    // The resumed body re-entered exactly once.
    expect(dispatches.assess).toBe(2)

    expect(readBack("SELECT status FROM flows_runs ORDER BY run_id")).toEqual([["completed"], ["completed"]])
  }, 60_000)
})
