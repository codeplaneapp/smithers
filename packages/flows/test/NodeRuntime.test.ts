/**
 * The supported production composition, booted end to end over a real SQLite
 * file.
 *
 * `src/NodeRuntime.ts` is the one module in this package that a host program
 * calls to stand a durable engine up, and every claim its doc comment makes is
 * an ordering claim: the parent directory exists before the database opens,
 * migrations finish before a store is built, the engine is built over those
 * stores, and `registerFlows` finishes before the composed services are
 * exposed — so a persisted run cannot resume through this composition before
 * its flow has been registered. None of that is observable from a type, and a
 * double cannot establish any of it, so this suite drives the module the way a
 * program does: one temp-directory SQLite file, three separate scopes over it,
 * and `node:sqlite` reading the same file back independently.
 *
 * The three scopes are the whole journey. Scope one migrates, registers, runs
 * a flow to completion, and parks a second flow on a durable deferred. Its
 * closure is the graceful shutdown — the module installs no signal handlers,
 * so scope closure is the documented shutdown path. Scope two is a process
 * that completes the deferred but registers NO flow: the run must stay parked,
 * because the engine leaves a wake for an unregistered flow alone. Scope three
 * registers the flow again and touches nothing else; the registration sweep is
 * what has to notice the completed deferred and drive the run home.
 *
 * The host seams are supplied here rather than by the library, the same way a
 * program supplies them: a tiny Node filesystem bridge for the one directory
 * creation the composition owns, SHA-256 over `node:crypto`, and a `Jj` stub
 * because the flows below take no compensable snapshot.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { createHash, webcrypto } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
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
import * as NodeRuntime from "../src/NodeRuntime.ts"

const { StepBoundary, WorkspaceSandbox } = EngineStorePackage
const { RunStore } = RunStorePackage
const { Jj } = Kernel

const directory = mkdtempSync(join(tmpdir(), "flows-node-runtime-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * The database lives one level BELOW the temp directory that exists. Creating
 * the parent recursively is the composition's first documented step, so the
 * filename is chosen to fail if it is skipped.
 */
const filename = join(directory, "state", "gate.sqlite")

/**
 * A Jujutsu service that records nothing. The engine calls it for compensable
 * snapshots; every flow here is ordinary, so a stub keeps the composition
 * honest without requiring a jj binary on the host.
 */
const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "node-runtime-gate" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** SHA-256 and random bytes from Node's built-in crypto service. */
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

/** The composition itself only needs to create the configured database parent. */
const hostFileSystem: Layer.Layer<FileSystem.FileSystem> = Layer.succeed(
  FileSystem.FileSystem,
  FileSystem.makeNoop({
    makeDirectory: (path, options) =>
      Effect.sync(() => {
        mkdirSync(path, { recursive: options?.recursive })
      })
  })
)

/** The three services the composition leaves to the host program. */
const host = Layer.mergeAll(hostCrypto, hostFileSystem, stubJj)

/** Every dispatch the journey makes, so a replayed one is visible as a count. */
const dispatches = { assess: 0, read: 0, tally: 0 }

const Approval = DurableDeferred.make("flows/gate/approval", {
  success: Schema.String
})

/**
 * A sealed step in front of the durable wait. Its result is journaled on the
 * first pass, so a resumed run that re-enters the body must NOT dispatch it
 * again — the counter below is that contract.
 */
const ReadDocument = Action.make({
  name: "flows/gate/read-document",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "flows/gate/read-document/v1",
  execute: Effect.sync(() => {
    dispatches.read += 1
    return "draft body"
  })
})

const Assess = Action.make("flows/gate/assess", {
  payload: { document: Schema.String },
  success: Schema.String
})

const Review = Flow.make("flows/gate/review", {
  payload: { document: Schema.String },
  success: Schema.String,
  body: (payload) => Assess.call(payload)
})

const Tally = Action.make("flows/gate/tally", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Count = Flow.make("flows/gate/count", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Tally.call({ value })
})

const assess = ({ document }: { readonly document: string }) =>
  Effect.gen(function*() {
    dispatches.assess += 1
    const body = yield* ReadDocument
    const verdict = yield* DurableDeferred.await(Approval)
    return `${document}:${body}:${verdict}`
  })

const tally = ({ value }: { readonly value: number }) =>
  Effect.sync(() => {
    dispatches.tally += 1
    return value * 2
  })

/**
 * The registration phase the composition takes as its final startup step.
 *
 * The implementations are provided BENEATH the interpreters rather than merged
 * beside them, so the table a dispatch reads is filled before any flow is
 * registered. Registration is what arms the sweep, and the sweep can re-drive
 * a persisted run immediately — a run that woke into a half-built
 * implementation table would be a race this ordering removes.
 */
const registerFlows = Layer.mergeAll(Interpreter.layer(Review), Interpreter.layer(Count)).pipe(
  Layer.provideMerge(Layer.mergeAll(Assess.toLayer(assess), Tally.toLayer(tally))),
  Layer.provideMerge(Action.layerImplementations)
)

const options = (hostId: string) => ({
  filename,
  owner: { hostId },
  // A single-process host: no previously recorded owner is ever still alive.
  isAlive: () => Effect.succeed(false)
})

/** One incarnation of the production runtime, with its flows registered. */
const incarnation = (hostId: string) =>
  NodeRuntime.layer(
    options(hostId),
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registerFlows
  ).pipe(Layer.provide(host))

/** The same runtime with NO flow registered, which is a different process. */
const bystander = (hostId: string) =>
  NodeRuntime.layer(
    options(hostId),
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    Layer.empty
  ).pipe(Layer.provide(host))

/** Reads the file back through an independent connection, not through a store. */
const readBack = <A>(query: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    return query(database)
  } finally {
    database.close()
  }
}

/** The value a settled poll answered with, and `undefined` while it has none. */
const completedValue = (result: Option.Option<Flow.Result<unknown, unknown>>): unknown =>
  Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)
    ? result.value.exit.value
    : undefined

describe("the supported Node SQLite composition", () => {
  it("refuses an unusable configuration before it opens anything", () => {
    // Validation is eager: `layer` builds the composition when it is CALLED,
    // so a program with an empty filename fails at wiring time rather than
    // opening a database at some arbitrary later scope.
    expect(() =>
      NodeRuntime.layer(
        { filename: "", owner: { hostId: "gate" }, isAlive: () => Effect.succeed(false) },
        StepBoundary.layer,
        WorkspaceSandbox.layerFileSystem(),
        Layer.empty
      )
    ).toThrow()
    expect(() =>
      NodeRuntime.layer(
        { filename, owner: { hostId: "" }, isAlive: () => Effect.succeed(false) },
        StepBoundary.layer,
        WorkspaceSandbox.layerFileSystem(),
        Layer.empty
      )
    ).toThrow()
    expect(() => NodeRuntime.storage("")).toThrow()
    // Nothing above may have created the database the journey below owns.
    expect(existsSync(filename)).toBe(false)
  })

  it("migrates, runs, shuts down, and resumes a parked run over one file", async () => {
    // ---------------------------------------------------------------- scope 1
    // Migrate, register, drive one flow to completion, park a second.
    const first = await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const value = yield* Count.execute({ value: 21 }, { executionId: "gate-count" })
        yield* Review.execute({ document: "rfc" }, {
          executionId: "gate-review",
          discard: true
        })
        return {
          count: yield* runs.get("gate-count"),
          review: yield* runs.get("gate-review"),
          value
        }
      }).pipe(Effect.provide(incarnation("gate-a")), Effect.provide(hostCrypto), Effect.scoped)
    )

    expect(first.value).toBe(42)
    expect(first.count.status).toBe("completed")
    // The parked run released its claim, which is what makes it reclaimable.
    expect(first.review.status).toBe("suspended")
    expect(first.review.owner).toBeNull()
    expect(dispatches).toEqual({ assess: 1, read: 1, tally: 1 })

    // The composition created the parent directory it was pointed below, and
    // the durable state is a real file on disk that another connection reads.
    expect(existsSync(filename)).toBe(true)
    const persisted = readBack((database) => ({
      runs: database.prepare("SELECT run_id, status FROM flows_runs ORDER BY run_id").all(),
      deferred: database.prepare("SELECT COUNT(*) AS total FROM flows_deferred_completions").get(),
      journal: database.prepare("SELECT COUNT(*) AS total FROM flows_journal_events").get()
    }))
    expect(persisted.runs).toEqual([
      { run_id: "gate-count", status: "completed" },
      { run_id: "gate-review", status: "suspended" }
    ])
    // Migrations ran and the journal recorded the lifecycle; the deferred the
    // parked run waits on has no completion yet.
    expect((persisted.journal as { total: number }).total).toBeGreaterThan(0)
    expect(persisted.deferred).toEqual({ total: 0 })

    // ---------------------------------------------------------------- scope 2
    // A process that completes the deferred but registers no flow. The wake it
    // schedules must find no registration and leave the durable waiting row
    // alone, so the run is still there for a worker that registers the flow.
    const second = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.deferredDone(Approval, {
          flowName: Review._tag,
          executionId: "gate-review",
          deferredName: Approval.name,
          exit: Exit.succeed("approved")
        })
        const runs = yield* RunStore.RunStore
        // Long enough for a resume this process must NOT perform.
        yield* Effect.sleep("250 millis")
        return yield* runs.get("gate-review")
      }).pipe(Effect.provide(bystander("gate-b")), Effect.scoped)
    )

    expect(second.status).toBe("suspended")
    expect(dispatches.assess).toBe(1)
    expect(readBack((database) => database.prepare("SELECT COUNT(*) AS total FROM flows_deferred_completions").get()))
      .toEqual({ total: 1 })

    // ---------------------------------------------------------------- scope 3
    // Registration is the only thing this scope asks for. The sweep the
    // engine arms on `register` is what has to notice the completed deferred
    // and drive the parked run to a result.
    const third = await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        let row = yield* runs.get("gate-review")
        for (let attempt = 0; attempt < 200 && row.status === "suspended"; attempt++) {
          yield* Effect.sleep("25 millis")
          row = yield* runs.get("gate-review")
        }
        return {
          replayed: yield* Count.execute({ value: 21 }, { executionId: "gate-count" }),
          result: yield* Review.poll("gate-review"),
          row
        }
      }).pipe(Effect.provide(incarnation("gate-c")), Effect.provide(hostCrypto), Effect.scoped)
    )

    expect(third.row.status).toBe("completed")
    expect(completedValue(third.result)).toBe("rfc:draft body:approved")
    // The settled run from scope one is read back, not re-executed.
    expect(third.replayed).toBe(42)
    expect(dispatches.tally).toBe(1)
    // The resumed body re-entered, and the sealed step in front of the wait
    // replayed its journaled result instead of dispatching a second time.
    expect(dispatches.assess).toBe(2)
    expect(dispatches.read).toBe(1)

    expect(readBack((database) => database.prepare("SELECT status FROM flows_runs ORDER BY run_id").all()))
      .toEqual([{ status: "completed" }, { status: "completed" }])
  }, 60_000)
})
