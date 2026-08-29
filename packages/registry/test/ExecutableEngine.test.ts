/**
 * A discovered flow, run.
 *
 * `Executable.test.ts` proves the bridge builds the right declaration. This
 * one proves the declaration is one the durable engine drives: every case runs
 * against a real `EngineStore` over a SQLite FILE, with the production
 * `StepBoundary` and filesystem `WorkspaceSandbox`, because the answers that
 * matter here — a settled execution, a journal, a step-cache row reused by a
 * second run — do not exist in a memory engine.
 *
 * The golden in the middle is the annotation ladder: a cache policy declared on
 * a descriptor's body reaches the recorded result, a declared priority reaches
 * the plan scheduler's admission order, and a declared placement reaches the
 * envelope the delegate a host spawns reads.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as PlanScheduler from "@smthrs/engine-store/PlanScheduler"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node, Plan } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"

const flowsRoot = fileURLToPath(new URL("./fixtures/executable/flows", import.meta.url))
const projectRoot = fileURLToPath(new URL("./fixtures/executable", import.meta.url))
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** What the delegate was handed, in call order. */
const spawned: Array<Executable.Invocation> = []

/** How many times the sealed step under the delegate actually executed. */
let executions = 0

/**
 * The sealed step whose recorded result may be reused.
 *
 * A shareable step needs all three declarations: `tier: "sealed"`, an
 * `idempotencyKey` another run can derive, and a HARD file boundary the host
 * measures the execution against. An empty read and write set is the honest
 * declaration for a body that touches no files.
 */
const Compile = Action.make({
  name: "registry-test/Compile",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "registry-test/compile/v1",
  metadata: { readSet: [], writeSet: [], boundaryMode: "hard" },
  execute: Effect.sync(() => {
    executions++
    return "compiled"
  })
})

/** The action the delegate's body names; the host attaches its code below. */
const Run = Action.make("registry-test/Run", {
  payload: Executable.Invocation,
  success: Schema.String
})

/**
 * The registered flow every fixture delegates to.
 *
 * It stands in for the host driver a real composition registers — the agent
 * cell, the shell runner — and it is a real `@smthrs/flow` flow, registered
 * the same way, so what this suite proves about the bridge holds for those.
 */
const Echo = Flow.make("test/echo", {
  payload: Executable.Invocation,
  success: Schema.String,
  body: (payload) => Run.call(payload)
})

const runLayer = Run.toLayer((payload) =>
  Effect.map(Compile, (artifact) => {
    spawned.push(payload)
    return `${payload.flow}:${artifact}`
  })
)

const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "registry-executable-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const scan = Effect.gen(function*() {
  const discovery = yield* Discovery.Discovery
  return yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" })
}).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(platform))), Effect.provide(platform))

const descriptorNamed = (name: string) =>
  Effect.map(scan, (result) => {
    const found = result.entries.find((entry) => entry.name === name)
    expect(found, name).toBeDefined()
    return found as Descriptor.FlowDescriptor
  })

const executableNamed = (name: string) =>
  Effect.flatMap(
    descriptorNamed(name),
    (descriptor) => Executable.fromDescriptor(descriptor, { delegates: [Echo] })
  ).pipe(Effect.provide(platform))

/** A private directory for one case's engine database and workspace. */
const workspace = (name: string): string => mkdtempSync(join(tmpdir(), `registry-executable-${name}-`))

/**
 * The durable runtime the bridged flow is registered with: real SQLite, the
 * production boundary and sandbox pairing that makes a sealed result eligible
 * for the step cache, and a complete cache environment so the engine may claim
 * a result is reusable at all.
 */
const durable = (filename: string, hostId: string, registration: Layer.Layer<unknown, never, never>) =>
  NodeRuntime.layer(
    {
      filename,
      owner: { hostId },
      isAlive: () => Effect.succeed(false)
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(stubJj, Action.layerCacheEnvironment({ layers: [], capabilities: {} }))
    ),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(platform)
  )

const registrationFor = (executable: Executable.Executable) =>
  Layer.mergeAll(runLayer, Interpreter.layer(Echo), executable.layer).pipe(
    Layer.provideMerge(Action.layerImplementations)
  ) as Layer.Layer<unknown, never, never>

/** Executes one bridged flow and reads the journal that execution wrote. */
const execute = (
  executable: Executable.Executable,
  filename: string,
  hostId: string,
  executionId: string,
  input: Schema.Json
) =>
  Effect.gen(function*() {
    const result = yield* executable.flow.execute({ input }, { executionId })
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 200 })
    return { result, events: page.entries.map((entry) => entry.eventType) }
  }).pipe(
    Effect.provide(durable(filename, hostId, registrationFor(executable))),
    Effect.scoped,
    Effect.orDie
  )

describe("a discovered flow runs on the durable engine", () => {
  it.effect("drives a flow.ts descriptor to completion over SQLite", () =>
    Effect.gen(function*() {
      spawned.length = 0
      const directory = workspace("module")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("greet")
      const observed = yield* execute(executable, filename, "registry-module", "greet-1", { name: "world" })

      expect(observed.result).toBe("greet:compiled")
      // The run went through the durable engine, not around it: the database
      // file exists and the execution's lifecycle is journalled under its id.
      expect(existsSync(filename)).toBe(true)
      expect(observed.events.length).toBeGreaterThan(0)
      // The delegate received the descriptor's metadata and the caller's input.
      expect(spawned.map((invocation) => invocation.flow)).toEqual(["greet"])
      expect(spawned[0]?.input).toEqual({ name: "world" })
      expect(spawned[0]?.flows).toEqual(["test/echo"])
    }))

  it.effect("drives a flow.mdx descriptor to completion over SQLite", () =>
    Effect.gen(function*() {
      spawned.length = 0
      const directory = workspace("markdown")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("changelog")
      const observed = yield* execute(executable, filename, "registry-markdown", "changelog-1", { args: "v2" })

      expect(observed.result).toBe("changelog:compiled")
      expect(existsSync(filename)).toBe(true)
      // A markdown flow's body reaches the delegate as a rendered prompt: this
      // is the whole of what makes a `flow.mdx` runnable rather than readable.
      expect(spawned[0]?.prompt).toContain("Summarize the changes since the previous release")
      expect(spawned[0]?.prompt).toContain("Base directory:")
      expect(spawned[0]?.input).toEqual({ args: "v2" })
    }))

  it.effect("refuses a discovered flow whose delegate no host registered", () =>
    Effect.gen(function*() {
      const descriptor = yield* descriptorNamed("orphan").pipe(Effect.provide(platform))
      const failure = yield* Effect.flip(
        Executable.fromDescriptor(descriptor, { delegates: [Echo] }).pipe(Effect.provide(platform))
      )
      // The refusal happens before the engine is asked to drive anything, so
      // an operator reads the missing flow's name instead of an empty `AnyOf`
      // issue raised at dispatch.
      expect(failure.code).toBe("missing_delegate")
      expect(failure.message).toContain("test/missing")
    }))
})

describe("the annotation golden", () => {
  it.effect("serves a second run the result the first one recorded", () =>
    Effect.gen(function*() {
      executions = 0
      spawned.length = 0
      const directory = workspace("cache")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("tuned")

      const first = yield* execute(executable, filename, "registry-cache-a", "tuned-1", { name: "one" })
      const second = yield* execute(executable, filename, "registry-cache-b", "tuned-2", { name: "two" })

      expect(first.result).toBe("tuned:compiled")
      expect(second.result).toBe("tuned:compiled")
      // Two runs, two executions, one dispatch of the sealed step: the second
      // run read the row the first one recorded out of the step cache in the
      // same SQLite file. What earns the reuse is the delegate's own sealed
      // step — its `tier`, its `idempotencyKey`, and its hard boundary — NOT
      // the descriptor's declared policy; the next case is why the difference
      // matters and how it is pinned.
      expect(spawned.length).toBe(2)
      expect(executions).toBe(1)
    }))

  it.effect("does not narrow the cache address from a descriptor's declared scope", () =>
    Effect.gen(function*() {
      executions = 0
      spawned.length = 0
      const directory = workspace("scoped")
      const filename = join(directory, "engine.db")
      const executable = yield* executableNamed("scoped")

      // The declaration says `scope: "run"`, which `@smthrs/engine-store`
      // `ActionPersistence` reads off a DISPATCHED ACTION and folds into the
      // cache row's address, so a second run would derive a different address
      // and re-execute. It is declared on the FLOW here, and rc.0 carries a
      // flow's annotation bag onto nothing: `@smthrs/flow` `Interpreter`
      // dispatches the actions the delegate's own body names and never reads
      // the enclosing flow's annotations.
      yield* execute(executable, filename, "registry-scoped-a", "scoped-1", { name: "one" })
      yield* execute(executable, filename, "registry-scoped-b", "scoped-2", { name: "two" })

      expect(executable.lowered.cache).toEqual({ scope: "run" })
      // 2 is what a policy that reached dispatch would produce. This assertion
      // is the pin on rc.0's real behavior, and the red-on-fix test for the
      // Phase 5 flow-primitives row "Interpreter ignores the enclosing flow's
      // CachePolicyAnnotation": when that lands, this number becomes 2 and the
      // claim in `Lowered.cache` changes with it.
      expect(executions).toBe(1)
      expect(spawned.length).toBe(2)
    }))

  it.effect("hands the delegate the placement the descriptor declared", () =>
    Effect.gen(function*() {
      spawned.length = 0
      const directory = workspace("placement")
      const executable = yield* executableNamed("tuned")
      yield* execute(executable, join(directory, "engine.db"), "registry-placement", "tuned-3", { name: "one" })

      // What a host selects a spawn target with: the delegate the bridge
      // spawned sees the directive rather than having to re-read the source.
      expect(spawned[0]?.placement).toBe("sandbox")
      expect(executable.lowered.placement?._tag).toBe("flows/core/Placement/Sandbox")
    }))

  it.effect("starts the higher-priority discovered flow first under a capacity of one", () =>
    Effect.gen(function*() {
      const tuned = yield* executableNamed("tuned")
      const greet = yield* executableNamed("greet")
      // Two independent delegating nodes, ready in the same pass. `Node.all`
      // fixes no order and declaration order would start the unprioritized
      // one, so only the descriptor's declared priority can decide.
      const both = Flow.make("registry-test/both", {
        payload: {},
        success: Schema.Unknown,
        error: Schema.Unknown,
        body: () =>
          Node.all({
            plain: greet.flow.body({ input: null }),
            tuned: tuned.flow.body({ input: null })
          })
      })
      const drafts = Graph.drafts(Graph.build(both, {}))
      const idOf = (suffix: string): string => {
        const id = drafts.map((draft) => draft.id).find((candidate) => candidate.endsWith(suffix))
        expect(id, suffix).toBeDefined()
        return id as string
      }
      expect(drafts.find((draft) => draft.id === idOf(".all.tuned"))?.priority).toBe(7)

      const directory = workspace("priority")
      const started: Array<string> = []
      const owner: Ownership.OwnerId = { hostId: "registry-priority", pid: 11, nonce: "registry-priority-process" }
      const stores = TestStores.layerAt(join(directory, "scheduler.db"))
      const harness = Layer.mergeAll(
        StepBoundary.layerTest(),
        stubJj,
        PlanScheduler.layerExecutor({
          execute: ({ node }) =>
            Effect.sync(() => {
              started.push(node.id)
              return node.id
            })
        })
      ).pipe(Layer.provideMerge(stores), Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(platform))

      yield* Effect.gen(function*() {
        const plan = yield* Plan.compile({
          planId: "registry-priority-plan",
          flow: "registry-test/both",
          nodes: drafts
        })
        const runs = yield* RunStore.RunStore
        yield* runs.create("registry-priority-run", "{}")
        const row = yield* runs.get("registry-priority-run")
        const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
        const claim = yield* runs.claim("registry-priority-run", snapshot, owner, 1)
        if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
        const activated = yield* runs.activate("registry-priority-run", owner, claim.claimedAtMs, snapshot)
        if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
        yield* PlanScheduler.make({
          runId: "registry-priority-run",
          owner,
          sourceId: "registry-priority",
          concurrency: { steps: 1 }
        }).run(plan)
      }).pipe(Effect.provide(harness), Effect.scoped, Effect.orDie)

      const prioritized = started.indexOf(idOf(".all.tuned"))
      const plain = started.indexOf(idOf(".all.plain"))
      expect(prioritized).toBeGreaterThanOrEqual(0)
      expect(prioritized).toBeLessThan(plain)
    }))
})

describe("the host seam", () => {
  it.effect("registers every discovered flow through the runtime's registry parameter", () =>
    Effect.gen(function*() {
      spawned.length = 0
      const directory = workspace("host")
      const options: Executable.Options = { delegates: [Echo] }
      // The whole seam, composed the way a host composes it: discovery over
      // `<root>/flows/**` is the runtime's registry, and the registration phase
      // is the catalog built from it. Nothing lists a flow by hand.
      const runtime = NodeRuntime.layer(
        {
          filename: join(directory, "engine.db"),
          owner: { hostId: "registry-host" },
          isAlive: () => Effect.succeed(false)
        },
        StepBoundary.layer,
        WorkspaceSandbox.layerFileSystem(),
        Layer.mergeAll(runLayer, Interpreter.layer(Echo), Executable.layer(options)).pipe(
          Layer.provideMerge(Action.layerImplementations)
        ),
        Executable.layerProject({ root: projectRoot })
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(stubJj, Action.layerCacheEnvironment({ layers: [], capabilities: {} }))
        ),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(platform)
      )

      const observed = yield* Effect.gen(function*() {
        const executable = yield* Executable.fromRegistry("changelog", options)
        return yield* executable.flow.execute({ input: { args: "v3" } }, { executionId: "host-1" })
      }).pipe(Effect.provide(runtime), Effect.scoped, Effect.orDie)

      expect(observed).toBe("changelog:compiled")
      expect(spawned[0]?.flow).toBe("changelog")
      expect(spawned[0]?.input).toEqual({ args: "v3" })
    }))
})
