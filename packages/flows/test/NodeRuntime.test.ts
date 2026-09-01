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
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { createHash, webcrypto } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

/**
 * The host half of the composition.
 *
 * `layer` leaves the host to the caller: `Jj`, `FileSystem`, `Crypto`, the
 * step boundary and the workspace sandbox are arguments or requirements, and
 * every embedder wired the same pieces in the same order to satisfy them.
 * `layerHost` is that wiring, so these cases supply NOTHING but the option
 * record — a missing default shows up here as a boot failure or a denied
 * capability, not as a subtle difference in behavior.
 */
describe("the Node host composition", () => {
  const hostRoot = join(directory, "host")
  const hostFile = join(hostRoot, "runtime.sqlite")
  const note = join(hostRoot, "note.txt")

  /** Reads a workspace file through whatever `FileSystem` the host installed. */
  const ReadNote = Action.make({
    name: "flows/host/read-note",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/read-note/v1",
    execute: Effect.gen(function*() {
      const files = yield* FileSystem.FileSystem
      return yield* Effect.orDie(files.readFileString(note))
    })
  })

  /** Tries to run a command, and reports the refusal instead of failing on it. */
  const TrySpawn = Action.make({
    name: "flows/host/try-spawn",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/try-spawn/v1",
    execute: Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const attempt = yield* Effect.exit(spawner.string(ChildProcess.make("echo", ["hi"])))
      return Exit.isFailure(attempt) ? `refused: ${String(attempt.cause)}` : `ran: ${attempt.value}`
    })
  })

  const Probe = Action.make("flows/host/probe", {
    payload: { what: Schema.String },
    success: Schema.String
  })

  const Host = Flow.make("flows/host/probe-flow", {
    payload: { what: Schema.String },
    success: Schema.String,
    body: (payload) => Probe.call(payload)
  })

  /** The process group the sleeping action left running, for the kill assertion. */
  const spawned: Array<number> = []

  /** The same, for the run a SECOND driver interrupts. */
  const interrupted: Array<number> = []

  /**
   * A compensable action. The ENGINE, not the body, takes a jj pre-image before
   * this runs, through the same guarded `Jj` a flow body sees, so a host whose
   * grant store has no `jj:*` rule could not execute it at all.
   */
  const Mutate = Action.make({
    name: "flows/host/mutate",
    success: Schema.String,
    tier: "compensable",
    idempotencyKey: "flows/host/mutate/v1",
    execute: Effect.succeed("mutated")
  })

  /** Spawns a two-process tree and waits for it, so a released run has one to kill. */
  const Sleep = Action.make({
    name: "flows/host/sleep",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/sleep/v1",
    execute: Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* Effect.orDie(spawner.spawn(ChildProcess.make("sh", ["-c", "sleep 60 & sleep 60"])))
      spawned.push(handle.pid as number)
      yield* Effect.orDie(handle.exitCode)
      return "woke"
    })
  })

  const groupIsAlive = (pgid: number): boolean => {
    try {
      process.kill(-pgid, 0)
      return true
    } catch {
      return false
    }
  }

  /** A second sleeping tree, so the interrupt case does not share the first's. */
  const SleepAgain = Action.make({
    name: "flows/host/sleep-again",
    success: Schema.String,
    tier: "sealed",
    idempotencyKey: "flows/host/sleep-again/v1",
    execute: Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* Effect.orDie(spawner.spawn(ChildProcess.make("sh", ["-c", "sleep 60 & sleep 60"])))
      interrupted.push(handle.pid as number)
      yield* Effect.orDie(handle.exitCode)
      return "woke"
    })
  })

  const probe = ({ what }: { readonly what: string }) =>
    Effect.gen(function*() {
      if (what === "read") return yield* ReadNote
      if (what === "spawn") return yield* TrySpawn
      if (what === "mutate") return yield* Mutate
      if (what === "sleep-again") return yield* SleepAgain
      return yield* Sleep
    })

  const hostFlows = Interpreter.layer(Host).pipe(
    Layer.provideMerge(Probe.toLayer(probe)),
    Layer.provideMerge(Action.layerImplementations)
  )

  const readHostBack = <A>(query: (database: DatabaseSync) => A): A => {
    const database = new DatabaseSync(hostFile, { readOnly: true })
    try {
      return query(database)
    } finally {
      database.close()
    }
  }

  it("runs a sealed host-reading action with nothing but its own options", async () => {
    mkdirSync(hostRoot, { recursive: true })
    writeFileSync(note, "host note")

    const value = await Effect.runPromise(
      Host.execute({ what: "read" }, { executionId: "host-read" }).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            {
              filename: hostFile,
              owner: { hostId: "host-a" },
              signals: [],
              rules: [[
                new Permission.Rule({
                  effect: "allow",
                  pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: `${hostRoot}/**` })
                })
              ]]
            },
            hostFlows
          )
        ),
        Effect.scoped
      )
    )

    expect(value).toBe("host note")
  }, 60_000)

  it("denies a process spawn that no rule authorizes", async () => {
    const value = await Effect.runPromise(
      Host.execute({ what: "spawn" }, { executionId: "host-spawn" }).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            { filename: hostFile, owner: { hostId: "host-b" }, signals: [] },
            hostFlows
          )
        ),
        Effect.scoped
      )
    )

    expect(value).toMatch(/^refused:/)
  }, 60_000)

  it("installs the shutdown signals it was not told about, and removes them again", async () => {
    const before = process.listenerCount("SIGTERM")

    const during = await Effect.runPromise(
      Effect.sync(() => process.listenerCount("SIGTERM")).pipe(
        Effect.provide(
          NodeRuntime.layerHost({ filename: hostFile, owner: { hostId: "host-c" } }, Layer.empty)
        ),
        Effect.scoped
      )
    )

    expect(during).toBe(before + 1)
    expect(process.listenerCount("SIGTERM")).toBe(before)
  }, 60_000)

  it("leaves with the signal's default status when the operator signals twice", async () => {
    // The handler's two escapes only run in a process that is on its way out,
    // so the child-process suites can observe their EFFECT but never execute
    // them here. Emitting the signal on this process drives the very listener
    // `layerHost` installed, with `process.exit` captured so the worker
    // survives to assert on what the handler asked for.
    const asked: Array<number | undefined> = []
    const realExit = process.exit
    ;(process as unknown as { exit: unknown }).exit = (code?: number) => {
      asked.push(code)
    }

    try {
      await Effect.runPromise(
        Effect.promise(async () => {
          // The first signal is the graceful path: it closes the runtime scope
          // and arms the deadline, and asks for no exit itself.
          process.emit("SIGTERM")
          expect(asked).toEqual([])
          // A zero deadline is the shutdown that outlasted its budget, so the
          // timer leaves on the next macrotask rather than after a wall-clock
          // wait this suite would have to sit through.
          await new Promise((resolve) => setTimeout(resolve, 5))
          // The third is the operator asking twice.
          process.emit("SIGTERM")
        }).pipe(
          Effect.provide(
            NodeRuntime.layerHost(
              { filename: hostFile, owner: { hostId: "host-twice" }, shutdownTimeoutMs: 0 },
              Layer.empty
            )
          ),
          Effect.scoped
        )
      )
    } finally {
      ;(process as unknown as { exit: unknown }).exit = realExit
    }

    expect(asked).toEqual([NodeRuntime.signalExitCode("SIGTERM"), NodeRuntime.signalExitCode("SIGTERM")])
    // `128 + signal number` is the status the default disposition would have
    // produced, and an unrecognized name has no disposition to read, so it
    // answers `SIGTERM`'s.
    expect(NodeRuntime.signalExitCode("SIGTERM")).toBe(143)
    expect(NodeRuntime.signalExitCode("SIGINT")).toBe(130)
    expect(NodeRuntime.signalExitCode("SIGNOTASIGNAL" as NodeJS.Signals)).toBe(143)
  }, 60_000)

  it("releases the run it owns when a shutdown signal arrives, and kills what it spawned", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const running = yield* Effect.forkChild(
          Effect.exit(Host.execute({ what: "sleep" }, { executionId: "host-signal" })),
          { startImmediately: true }
        )
        let row = yield* runs.get("host-signal")
        for (let attempt = 0; attempt < 400 && (row.status !== "running" || spawned.length === 0); attempt++) {
          yield* Effect.sleep("25 millis")
          row = yield* runs.get("host-signal")
        }
        expect(row.status).toBe("running")
        // The action really did start an OS process tree, so the assertion
        // below is about a process that existed.
        expect(spawned).toHaveLength(1)
        expect(groupIsAlive(spawned[0]!)).toBe(true)
        // SIGUSR2 is the one user signal Node does not reserve — SIGUSR1
        // starts the inspector — so the handler under test is the only
        // listener this raise reaches.
        yield* Effect.sync(() => process.kill(process.pid, "SIGUSR2"))
        yield* Effect.exit(Fiber.join(running))
      }).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            {
              filename: hostFile,
              owner: { hostId: "host-d" },
              signals: ["SIGUSR2"],
              rules: [[
                new Permission.Rule({
                  effect: "allow",
                  pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
                })
              ]]
            },
            hostFlows
          )
        ),
        Effect.scoped,
        Effect.exit
      )
    )

    // The run is reclaimable, not abandoned: `suspended` with the reason the
    // engine parks a released run under, and no owner still holding it.
    expect(
      readHostBack((database) =>
        database.prepare("SELECT status, waiting_reason, owner_host_id FROM flows_runs WHERE run_id = 'host-signal'")
          .get()
      )
    ).toMatchObject({ status: "suspended", waiting_reason: "released", owner_host_id: null })

    // Containment is what makes the release complete: the action's scope closed
    // with the run, and closing it took the whole process group with it rather
    // than leaving a `sleep` behind for nobody.
    const deadline = Date.now() + 10_000
    while (groupIsAlive(spawned[0]!) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(groupIsAlive(spawned[0]!)).toBe(false)
  }, 60_000)

  /**
   * Runs `body` with the process cwd inside a jj repository of this test's own.
   *
   * `layerHost` builds `NodeJj`, which runs `jj` in the process working
   * directory, so the engine's pre-image path only reaches jj's answer when
   * there is a repository above that directory. Reading the case's verdict out
   * of whatever the checkout happened to be made the machine part of the test:
   * a plain directory produced a jj failure and the case passed, and a checkout
   * that IS a jj repository -- the `jj git init --colocate` CI performs, and
   * what anyone developing this repository in jj already has -- ran the pre-image
   * to completion and reached the POST-image, which `engineRules` did not grant.
   * Creating the repository here makes the whole path run the same way
   * everywhere.
   *
   * The identity comes from the repository's own config rather than the
   * ambient one, because `jj describe` refuses without a name and an email and
   * neither a fresh CI runner nor a developer's machine is required to have
   * them.
   */
  const inOwnJjRepository = async <A>(body: () => Promise<A>): Promise<A> => {
    const repository = mkdtempSync(join(tmpdir(), "flows-node-runtime-jj-"))
    const entered = process.cwd()
    try {
      execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
      execFileSync("jj", ["config", "set", "--repo", "user.name", "flows test"], {
        cwd: repository,
        stdio: "ignore"
      })
      execFileSync("jj", ["config", "set", "--repo", "user.email", "test@flows.invalid"], {
        cwd: repository,
        stdio: "ignore"
      })
      process.chdir(repository)
      return await body()
    } finally {
      process.chdir(entered)
      rmSync(repository, { recursive: true, force: true })
    }
  }

  it("lets the engine take a compensable action's pre-image and post-image with no jj rule configured", async () => {
    // The engine's own `SnapshotBoundary` and `ActionPersistence` resolve the
    // GUARDED `Jj`, so before `engineRules` existed this composition could not
    // run a compensable action at all: the refusal arrived before the body,
    // aimed at the engine rather than at anything the flow asked for.
    //
    // The boundary is TWO capabilities, not one. `snapshot` opens the action's
    // pre-image, and `Effect.ensuring` closes every compensable action with
    // `diff`, which snapshots again and then asks jj what changed. A grant
    // covering only the pre-image let the action start and refused it on the
    // way out, which is the worst of both: the working copy was already moved.
    const value = await inOwnJjRepository(() =>
      Effect.runPromise(
        Host.execute({ what: "mutate" }, { executionId: "host-mutate" }).pipe(
          Effect.provide(
            NodeRuntime.layerHost(
              { filename: hostFile, owner: { hostId: "host-m" }, signals: [] },
              hostFlows
            )
          ),
          Effect.scoped
        )
      )
    )

    expect(value).toBe("mutated")
    expect(NodeRuntime.engineRules.map((rule) => rule.pattern.action)).toEqual([
      "jj:snapshot",
      "jj:restore",
      "jj:diff"
    ])
  }, 60_000)

  it("still refuses the engine's pre-image when the program denies it", async () => {
    // `engineRules` are a DEFAULT, merged under the program's own policy: a
    // host that means to deny jj keeps denying it.
    const outcome = await Effect.runPromise(
      Effect.exit(Host.execute({ what: "mutate" }, { executionId: "host-mutate-denied" })).pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            {
              filename: hostFile,
              owner: { hostId: "host-n" },
              signals: [],
              rules: [
                new Permission.Rule({
                  effect: "deny",
                  pattern: new Capability.CapabilityPattern({ action: "jj:snapshot", resource: "*" })
                })
              ]
            },
            hostFlows
          )
        ),
        Effect.scoped
      )
    )

    expect(Exit.isFailure(outcome)).toBe(true)
    expect(String(Exit.isFailure(outcome) ? outcome.cause : "")).toMatch(/Permission/)
  }, 60_000)

  it("kills what a run spawned when a SECOND driver over the same file interrupts it", async () => {
    // Cancellation from another process is the shape an operator's `cancel`
    // has: the run is driven here and interrupted from a driver that shares
    // only the SQLite file. Containment has to survive that route too, not
    // just the signal one.
    const host = (hostId: string) =>
      NodeRuntime.layerHost(
        {
          filename: hostFile,
          owner: { hostId },
          signals: [],
          containment: { graceMs: 300 },
          rules: [
            new Permission.Rule({
              effect: "allow",
              pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
            })
          ]
        },
        hostFlows
      )

    const caller = await Effect.runPromise(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const running = yield* Effect.forkChild(
          Effect.exit(Host.execute({ what: "sleep-again" }, { executionId: "host-cancel" })),
          { startImmediately: true }
        )
        let row = yield* runs.get("host-cancel")
        for (let attempt = 0; attempt < 400 && (row.status !== "running" || interrupted.length === 0); attempt++) {
          yield* Effect.sleep("25 millis")
          row = yield* runs.get("host-cancel")
        }
        expect(row.status).toBe("running")
        expect(interrupted).toHaveLength(1)
        expect(groupIsAlive(interrupted[0]!)).toBe(true)

        // The second driver: its own engine, its own owner, the same file. Its
        // `interrupt` writes a durable cancellation request rather than
        // touching a fiber it does not hold.
        yield* Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.interrupt(Host, "host-cancel")
        }).pipe(Effect.provide(host("host-cancel-b")), Effect.scoped)

        // The owner observes the request on its heartbeat cadence, so the wait
        // is bounded by that plus the containment grace, not by a poll count.
        for (let attempt = 0; attempt < 80 && row.status !== "cancelled"; attempt++) {
          yield* Effect.sleep("100 millis")
          row = yield* runs.get("host-cancel")
        }
        expect(row.status).toBe("cancelled")

        // graceMs is 300 above, so the group has to be gone well inside this.
        for (let attempt = 0; attempt < 32 && groupIsAlive(interrupted[0]!); attempt++) {
          yield* Effect.sleep("25 millis")
        }
        expect(groupIsAlive(interrupted[0]!)).toBe(false)

        // The caller settles with the run. A cross-driver cancel interrupts
        // the fiber that asked for it, so nothing here interrupts it by hand:
        // the settlement is the assertion.
        let settled = running.pollUnsafe()
        for (let attempt = 0; attempt < 200 && settled === undefined; attempt++) {
          yield* Effect.sleep("25 millis")
          settled = running.pollUnsafe()
        }
        return settled
      }).pipe(Effect.provide(host("host-cancel-a")), Effect.scoped, Effect.exit)
    )

    // Asserted out here, where a failure is the test's: every `expect` inside
    // the block above is swallowed by its own `Effect.exit`.
    const settled = Exit.isSuccess(caller) ? caller.value : undefined
    expect(settled).toBeDefined()
    const outcome = settled !== undefined && Exit.isSuccess(settled)
      ? settled.value as Exit.Exit<unknown, unknown>
      : settled
    expect(outcome !== undefined && Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)).toBe(true)

    // Read back through an independent connection: what the second driver's
    // request produced is a durable row, not an in-process observation.
    expect(
      readHostBack((database) => database.prepare("SELECT status FROM flows_runs WHERE run_id = 'host-cancel'").get())
    ).toMatchObject({ status: "cancelled" })
  }, 60_000)
})
