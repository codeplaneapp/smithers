/**
 * The executor's failure edges, one refusing collaborator at a time.
 *
 * `AgentSession.test.ts` drives the whole production stack along the path
 * where every collaborator answers. What that can never reach is the other
 * half of the composition: the control store, the journal, the grant store,
 * the status fence, the registry, and the durable engine each have a refusal
 * the executor must contain rather than propagate, and a stack whose
 * collaborators all work cannot produce one. So this file assembles the same
 * executor over stubs and refuses in exactly one place per case.
 *
 * Two collaborators stay real. The durable engine is `FlowEngine.layerMemory`,
 * so registration, execution, polling, and resumption behave as production
 * does; and the approval flow is the real `StandardFlows.approval` binding, so
 * an ask reaches the grant store exactly the way a cell's `ctx.call("ask", …)`
 * reaches it. The agent is a stub, because the loop itself is asserted in
 * `Agent.test.ts` — here it is the injection point for the two hooks the
 * executor hands it, `authorize` and the composed `ask` flow.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { LaunchFailed, PersistenceError } from "@smthrs/control/ControlError"
import type * as ControlExecutor from "@smthrs/control/ControlExecutor"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { RunStatus } from "@smthrs/control/ControlSchema"
import { FlowEngine } from "@smthrs/engine"
import { FlowRuntime } from "@smthrs/flow"
import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { RegistryError } from "@smthrs/registry/RegistryError"
import { Deferred, Duration, Effect, Fiber, Layer, Option, PubSub, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"

const route: FlowEngineLike.RouteResolver = {
  prepare: () =>
    Effect.succeed({
      routeId: "route-a",
      protocolId: "test-protocol",
      method: "POST",
      url: "https://example.invalid/v1/messages",
      publicHeaders: { "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
      bodyText: "{}"
    })
}

const model = Model.make({ stream: () => Stream.empty })

const flowId = "agents/notes"

const descriptorOf = (seat: Option.Option<string>): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name: flowId,
    description: "The notes agent.",
    body: new Descriptor.BodyRefMarkdown({ path: "/flows/agents/notes/flow.md", baseDirectory: "/flows/agents/notes" }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: seat,
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    modelInvocable: false,
    path: "/flows/agents/notes",
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const seated = descriptorOf(Option.some("anthropic:test-model"))

const promptBody = new Descriptor.FlowBodyPrompt({
  text: "Keep the note log tidy.",
  baseDirectory: "/flows/agents/notes"
})

const moduleBody = new Descriptor.FlowBodyModule({ path: "/flows/agents/notes/flow.ts" })

const envelope = { capabilities: [], flows: [], budget: {} }

const runId = "run-1"
const planId = "plan-1"

const launchInput: ControlExecutor.Launch = {
  plan: {
    card: {
      planId,
      flowId,
      digest: "plan-digest",
      inputSummary: "{}",
      envelope,
      deployClass: false,
      nodes: [],
      approval: {
        target: { _tag: "Plan", planId, digest: "plan-digest", envelope },
        scope: "run",
        idempotencyKey: `approve:${planId}`
      }
    },
    decodedInput: {},
    decision: "approved"
  },
  run: { runId, flowId, status: "running", planId, createdAt: 1, updatedAt: 1 }
}

const accepted = { _tag: "Accepted" as const, seq: JournalEvent.Seq.make(1), sourceSeq: JournalEvent.SourceSeq.make(1) }

/**
 * The seven `ControlRuntime` members the executor actually reaches, and no
 * others. Writing the stub against this shape rather than the whole service
 * states the executor's real dependency surface: a run driver reads the run
 * and its plan, registers its own fiber for cancellation, registers and reads
 * approvals, and fences every status write.
 */
interface RuntimeStub {
  readonly getRun: ControlRuntime["Service"]["getRun"]
  readonly getPlan: ControlRuntime["Service"]["getPlan"]
  readonly registerFiber: ControlRuntime["Service"]["registerFiber"]
  readonly registerApproval: ControlRuntime["Service"]["registerApproval"]
  readonly grants: ControlRuntime["Service"]["grants"]
  readonly claimFence: ControlRuntime["Service"]["claimFence"]
  readonly writeStatus: ControlRuntime["Service"]["writeStatus"]
}

interface Recorder {
  /** Every fenced status transition the executor wrote, in order. */
  readonly statuses: Array<RunStatus>
  /** Every durable journal event the executor emitted, in order. */
  readonly journaled: Array<{ readonly eventType: string; readonly payload: unknown }>
  /** Fires on the first status write, so a scenario never sleeps blindly. */
  readonly settled: Deferred.Deferred<RunStatus>
  /** Fires when the resume bridge has actually subscribed to the journal. */
  readonly subscribed: Deferred.Deferred<void>
}

const recorder = (): Recorder => ({
  statuses: [],
  journaled: [],
  settled: Deferred.makeUnsafe<RunStatus>(),
  subscribed: Deferred.makeUnsafe<void>()
})

const runtimeLayer = (
  record: Recorder,
  overrides: Partial<RuntimeStub> = {}
): Layer.Layer<ControlRuntime> => {
  const stub: RuntimeStub = {
    getRun: () => Effect.succeed(launchInput.run),
    getPlan: () => Effect.succeed(launchInput.plan),
    registerFiber: () => Effect.void,
    registerApproval: (target) => Effect.succeed({ tokenId: target.requestId, target, resolved: false }),
    grants: Effect.succeed([]),
    claimFence: () => Effect.succeed("fence-1"),
    writeStatus: (_runId, _fence, status) =>
      Effect.sync(() => {
        record.statuses.push(status)
        Deferred.doneUnsafe(record.settled, Effect.succeed(status))
        return { ...launchInput.run, status }
      }),
    ...overrides
  }
  return Layer.succeed(ControlRuntime)(stub as unknown as ControlRuntime["Service"])
}

const journalLayer = (
  record: Recorder,
  overrides: Partial<Journal.Service> = {}
): Layer.Layer<Journal.Journal> =>
  Layer.succeed(Journal.Journal)(
    Journal.makeNoop({
      emitDurableUnfenced: (input) =>
        Effect.sync(() => {
          record.journaled.push({ eventType: input.eventType, payload: input.payload })
          return accepted
        }),
      emitLossy: () => Effect.succeed(accepted),
      ...overrides
    })
  )

const registryLayer = (overrides: Partial<Registry.Registry> = {}): Layer.Layer<Registry.Registry> =>
  Layer.succeed(Registry.Registry)(
    Registry.makeNoop({
      list: () => Effect.succeed([seated]),
      visible: () => Effect.succeed([]),
      get: () => Effect.succeed(seated),
      getOption: () => Effect.succeed(Option.some(seated)),
      loadBody: () => Effect.succeed(promptBody),
      ...overrides
    })
  )

const seatLayer = SeatResolver.layer({
  resolve: (id) => Effect.succeed(Seat.make({ id, model, route, contextWindowTokens: 200_000 }))
})

/** The ask call a stub agent issues, in the shape the cell boundary builds. */
const askCall = new Cell.Call({
  flowName: "ask",
  input: { question: "publish the log?" },
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  identity: new Cell.CallIdentity({
    session: "session-1",
    frame: 0,
    cell: "cell-digest",
    ordinal: 0,
    declaration: "declaration-digest",
    layers: []
  })
})

/** An agent that gates one ask through the executor's own `authorize` hook. */
const askingAgent: Agent.Service = Agent.makeNoop({
  run: (options) =>
    Stream.unwrap(
      Effect.as(options.authorize === undefined ? Effect.void : options.authorize(askCall), Stream.empty)
    )
})

/**
 * An agent that calls the `ask` flow the executor composed, the way a cell
 * does — through the binding, so the asker's grant-store read happens exactly
 * where the harness makes it happen.
 */
const answeringAgent = (answers: Array<unknown>): Agent.Service =>
  Agent.makeNoop({
    run: (options) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const sources: ReadonlyArray<FlowBinding.Source> = options.flows ?? []
          const source = sources.find((entry) => entry.name === "host/approval")
          const bindings = source === undefined ? [] : yield* source.bindings()
          const binding = bindings.find((entry) => entry.descriptor.name === "ask")
          if (binding === undefined) return Stream.empty
          answers.push((yield* binding.run(askCall)).value)
          return Stream.empty
        })
      )
  })

type EngineService = FlowRuntime.FlowRuntime["Service"]

interface ScenarioOptions {
  readonly agent?: Agent.Service | undefined
  readonly runtime?: Partial<RuntimeStub> | undefined
  readonly journal?: Partial<Journal.Service> | undefined
  readonly registry?: Partial<Registry.Registry> | undefined
  readonly engine?: ((service: EngineService) => EngineService) | undefined
}

const engineLayer = (
  decorate: ScenarioOptions["engine"]
): Layer.Layer<FlowRuntime.FlowRuntime> =>
  decorate === undefined
    ? FlowEngine.layerMemory
    : Layer.effect(FlowRuntime.FlowRuntime)(
      Effect.map(
        Effect.gen(function*() {
          return yield* FlowRuntime.FlowRuntime
        }),
        decorate
      )
    ).pipe(Layer.provide(FlowEngine.layerMemory))

/**
 * Builds the executor over the stub composition and hands it to `scenario`.
 *
 * The scope is the executor's own: it owns the registered agent flow, the
 * resume bridge, and every forked run driver, so a scenario that outlived it
 * would be asserting against a torn-down composition.
 */
const withExecutor = <A>(
  record: Recorder,
  options: ScenarioOptions,
  scenario: (executor: ControlExecutor.Service) => Effect.Effect<A, unknown>
): Promise<A> =>
  Effect.gen(function*() {
    const executor = yield* AgentSession.make({ limits: { calls: 4 }, maxFrames: 2 })
    return yield* scenario(executor)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Agent.Agent)(options.agent ?? Agent.makeNoop()),
        seatLayer,
        runtimeLayer(record, options.runtime),
        registryLayer(options.registry),
        journalLayer(record, options.journal),
        NotificationQueue.layerNoop(),
        engineLayer(options.engine),
        NodeCrypto.layer
      )
    ),
    Effect.scoped,
    Effect.runPromise
  ) as Promise<A>

/** Launches one run and waits for the first fenced status it writes. */
const launched = (
  record: Recorder,
  options: ScenarioOptions = {}
): Promise<{ readonly acceptance: ControlExecutor.Acceptance; readonly status: RunStatus }> =>
  withExecutor(record, options, (executor) =>
    Effect.gen(function*() {
      const acceptance = yield* executor.launch(launchInput)
      const status = yield* Deferred.await(record.settled).pipe(
        Effect.timeout(Duration.seconds(10)),
        Effect.catchCause(() => Effect.succeed("accepted" as RunStatus))
      )
      return { acceptance, status }
    }))

const causeOf = (record: Recorder): string => {
  const failed = record.journaled.find((entry) => entry.eventType === "control.run.failed")
  return String((failed?.payload as { readonly cause?: unknown } | undefined)?.cause)
}

describe("the executor's control-store seam", () => {
  it("reports a control store that cannot register the approval as a typed harness failure", async () => {
    const record = recorder()
    const result = await launched(record, {
      agent: askingAgent,
      runtime: {
        registerApproval: () =>
          Effect.fail(
            new PersistenceError({ operation: "registerApproval", message: "the control store is gone" })
          )
      }
    })

    expect(result.acceptance).toBe("accepted")
    // The run failed rather than parking: an ask whose token was never
    // registered has no park for an operator to resume from.
    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain("The approval request could not be registered with the control plane")
  })

  it("reports a journal that cannot record the approval request as a typed harness failure", async () => {
    const record = recorder()
    const result = await launched(record, {
      agent: askingAgent,
      journal: {
        // Only the approval request is refused. The status writes that follow
        // must still land, or the failure this case is about is invisible.
        emitDurableUnfenced: (input) =>
          input.eventType === "control.approval.requested"
            ? Effect.fail(new Journal.JournalError({ code: "queue_overflow", message: "the journal is full" }))
            : Effect.sync(() => {
              record.journaled.push({ eventType: input.eventType, payload: input.payload })
              return accepted
            })
      }
    })

    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain("The approval request could not be journaled")
  })

  it("reports a grant store that cannot be read when the ask asks it", async () => {
    const record = recorder()
    const answers: Array<unknown> = []
    const result = await launched(record, {
      agent: answeringAgent(answers),
      runtime: {
        grants: Effect.fail(new PersistenceError({ operation: "grants", message: "the grant store is gone" }))
      }
    })

    // The ask never produced an answer, and the failure is the run's, not a
    // call result the cell could have caught.
    expect(answers).toEqual([])
    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain(`The grant store could not be read for run ${runId}`)
  })

  it("answers a decided ask denied when no grant carries its request id", async () => {
    const record = recorder()
    const answers: Array<unknown> = []
    const result = await launched(record, { agent: answeringAgent(answers) })

    expect(result.status).toBe("completed")
    expect(answers).toEqual([{ answer: "denied", approved: false }])
  })
})

describe("the executor's status fence", () => {
  it("keeps an authoritative terminal status when lifecycle journaling fails", async () => {
    const record = recorder()
    const registered = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>()
    const result = await withExecutor(
      record,
      {
        runtime: {
          registerFiber: (_runId, fiber) => Deferred.succeed(registered, fiber).pipe(Effect.asVoid)
        },
        journal: {
          emitDurableUnfenced: () =>
            Effect.fail(new Journal.JournalError({ code: "queue_overflow", message: "the journal is full" }))
        },
        engine: (engine) =>
          ({ ...engine, execute: () => Effect.fail("engine admission failed") }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          const acceptance = yield* executor.launch(launchInput)
          const fiber = yield* Deferred.await(registered)
          yield* Fiber.await(fiber)
          return { acceptance, status: record.statuses.at(-1) }
        })
    )

    expect(result).toEqual({ acceptance: "accepted", status: "failed" })
    expect(record.statuses).toEqual(["failed"])
  })

  it("propagates a failed authoritative status write through the owned driver", async () => {
    const record = recorder()
    const registered = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>()
    const result = await withExecutor(
      record,
      {
        runtime: {
          claimFence: () => Effect.die("the fence was claimed away"),
          registerFiber: (_runId, fiber) => Deferred.succeed(registered, fiber).pipe(Effect.asVoid)
        },
        engine: (engine) =>
          ({ ...engine, execute: () => Effect.fail("engine admission failed") }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          yield* executor.launch(launchInput)
          const fiber = yield* Deferred.await(registered)
          return yield* Fiber.await(fiber)
        })
    )

    expect(result._tag).toBe("Failure")
    expect(record.statuses).toEqual([])
    expect(record.journaled.filter((entry) => entry.eventType.startsWith("control.run."))).toEqual([])
  })
})

describe("the executor's registry seam", () => {
  it("refuses a launch whose discovered body cannot be loaded", async () => {
    const record = recorder()
    const failure = await withExecutor(
      record,
      {
        registry: {
          loadBody: () =>
            Effect.fail(new RegistryError({ code: "body_unavailable", message: "the flow file was deleted" }))
        }
      },
      (executor) => Effect.flip(executor.launch(launchInput))
    )

    expect(failure).toBeInstanceOf(LaunchFailed)
    expect((failure as LaunchFailed).message).toBe(`The body of flow ${flowId} could not be loaded`)
    expect(record.statuses).toEqual([])
  })

  it("fails the run when the registry loses the flow's seat between the launch and the body", async () => {
    const record = recorder()
    // The launch reads `getOption` and the body reads `get`, so a registry
    // that answers them differently is exactly the race the body re-validates
    // against.
    const result = await launched(record, { registry: { get: () => Effect.succeed(descriptorOf(Option.none())) } })

    expect(result.acceptance).toBe("accepted")
    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain("declares no model seat")
  })

  it("fails the run when the flow's body becomes a module between the launch and the body", async () => {
    const record = recorder()
    let loads = 0
    const result = await launched(record, {
      registry: { loadBody: () => Effect.sync(() => (loads++ === 0 ? promptBody : moduleBody)) }
    })

    expect(result.acceptance).toBe("accepted")
    expect(result.status).toBe("failed")
    expect(causeOf(record)).toContain("has a module body; only prompt flows run on the agent")
  })

  it("leaves a flow the registry does not disclose pending, and drives nothing", async () => {
    const record = recorder()
    const acceptance = await withExecutor(
      record,
      { registry: { getOption: () => Effect.succeed(Option.none()) } },
      (executor) => executor.launch(launchInput)
    )

    expect(acceptance).toBe("pending")
    expect(record.statuses).toEqual([])
  })

  it("leaves a discovered flow with no declared seat pending, and drives nothing", async () => {
    const record = recorder()
    const acceptance = await withExecutor(
      record,
      { registry: { getOption: () => Effect.succeed(Option.some(descriptorOf(Option.none()))) } },
      (executor) => executor.launch(launchInput)
    )

    expect(acceptance).toBe("pending")
    expect(record.statuses).toEqual([])
  })

  it("leaves a seated flow with a module body pending, and drives nothing", async () => {
    const record = recorder()
    const acceptance = await withExecutor(
      record,
      { registry: { loadBody: () => Effect.succeed(moduleBody) } },
      (executor) => executor.launch(launchInput)
    )

    expect(acceptance).toBe("pending")
    expect(record.statuses).toEqual([])
  })
})

describe("the executor's driver admission fence", () => {
  it("interrupts a driver that is cancelled before its flow body starts", async () => {
    const record = recorder()
    const registered = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>()
    const executing = Deferred.makeUnsafe<void>()
    const exit = await withExecutor(
      record,
      {
        runtime: {
          getRun: () => Effect.succeed({ ...launchInput.run, status: "running" }),
          registerFiber: (_runId, fiber) => Deferred.succeed(registered, fiber).pipe(Effect.asVoid)
        },
        engine: (engine) =>
          ({
            ...engine,
            execute: () => Effect.andThen(Deferred.succeed(executing, void 0), Effect.never)
          }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          yield* executor.launch(launchInput)
          const fiber = yield* Deferred.await(registered)
          yield* Deferred.await(executing)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        })
    )

    expect(exit._tag).toBe("Failure")
    expect(record.statuses).toEqual([])
  })

  it("never executes a driver when registration fails", async () => {
    const record = recorder()
    let executions = 0
    const failure = await withExecutor(
      record,
      {
        runtime: {
          registerFiber: () =>
            Effect.fail(new PersistenceError({ operation: "registerFiber", message: "registration refused" }))
        },
        engine: (engine) =>
          ({
            ...engine,
            execute: (...args: ReadonlyArray<unknown>) => {
              executions += 1
              return (engine.execute as unknown as (...values: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(
                ...args
              )
            }
          }) as unknown as EngineService
      },
      (executor) => Effect.flip(executor.launch(launchInput))
    )

    expect(failure).toMatchObject({ code: "launch_failed", runId })
    expect(executions).toBe(0)
  })

  it("treats a terminal control row as a stop signal, not start permission", async () => {
    const record = recorder()
    const checked = Deferred.makeUnsafe<void>()
    let executions = 0
    const acceptance = await withExecutor(
      record,
      {
        runtime: {
          getRun: () =>
            Effect.sync(() => {
              Deferred.doneUnsafe(checked, Effect.void)
              return { ...launchInput.run, status: "cancelled" as const }
            })
        },
        engine: (engine) =>
          ({
            ...engine,
            execute: () => Effect.sync(() => void (executions += 1))
          }) as unknown as EngineService
      },
      (executor) =>
        Effect.gen(function*() {
          const result = yield* executor.launch(launchInput)
          yield* Deferred.await(checked)
          return result
        })
    )

    expect(acceptance).toBe("accepted")
    expect(executions).toBe(0)
  })

  it("writes failed when the engine rejects before entering the registered body", async () => {
    const record = recorder()
    const result = await launched(record, {
      engine: (engine) =>
        ({ ...engine, execute: () => Effect.fail("engine admission failed") }) as unknown as EngineService
    })

    expect(result).toEqual({ acceptance: "accepted", status: "failed" })
  })
})

describe("the executor's resume bridge", () => {
  const entry = (runId: string, eventType: string): JournalEvent.Entry =>
    new JournalEvent.Entry({
      runId: JournalEvent.RunId.make(runId),
      seq: JournalEvent.Seq.make(1),
      eventId: `event-${runId}`,
      sourceId: JournalEvent.SourceId.make("/test/control"),
      sourceSeq: JournalEvent.SourceSeq.make(1),
      emittedAtMs: 1,
      eventType,
      payload: {},
      meta: {}
    })

  it("keeps following the journal after the engine refuses one re-drive", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const bothResumed = Deferred.makeUnsafe<void>()
    const hub = await Effect.runPromise(PubSub.unbounded<JournalEvent.Entry>())
    const attempted = await withExecutor(
      record,
      {
        journal: {
          changes: Effect.tap(PubSub.subscribe(hub), () => Deferred.succeed(record.subscribed, void 0))
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) =>
              Effect.suspend(() => {
                resumed.push(executionId)
                if (resumed.length === 2) Deferred.doneUnsafe(bothResumed, Effect.void)
                // The first re-drive dies. The bridge has to survive it and
                // still be following the journal when the next event lands.
                return resumed.length === 1 ? Effect.die("the engine refused the re-drive") : Effect.void
              })
          }) as unknown as EngineService
      },
      () =>
        Effect.gen(function*() {
          yield* Deferred.await(record.subscribed)
          yield* PubSub.publish(hub, entry("run-refused", "control.run.resume"))
          yield* PubSub.publish(hub, entry("run-accepted", "control.run.resumed"))
          yield* Deferred.await(bothResumed)
          return resumed
        })
    )

    // Both event types mean "re-drive", and the second was still delivered
    // after the first one's engine failure was contained.
    expect(attempted).toEqual(["run-refused", "run-accepted"])
  })

  it("ignores a journal entry that is not a resume event", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const resumedOnce = Deferred.makeUnsafe<void>()
    const hub = await Effect.runPromise(PubSub.unbounded<JournalEvent.Entry>())
    const attempted = await withExecutor(
      record,
      {
        journal: {
          changes: Effect.tap(PubSub.subscribe(hub), () => Deferred.succeed(record.subscribed, void 0))
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Effect.succeed(Option.some({ _tag: "Suspended" })),
            resume: (_flow: unknown, executionId: string) =>
              Effect.sync(() => {
                resumed.push(executionId)
                Deferred.doneUnsafe(resumedOnce, Effect.void)
              })
          }) as unknown as EngineService
      },
      () =>
        Effect.gen(function*() {
          yield* Deferred.await(record.subscribed)
          yield* PubSub.publish(hub, entry("run-other", "control.run.completed"))
          yield* PubSub.publish(hub, entry("run-resumed", "control.run.resumed"))
          yield* Deferred.await(resumedOnce)
          return resumed
        })
    )

    expect(attempted).toEqual(["run-resumed"])
  })

  it("does not re-drive an execution that never parked", async () => {
    const record = recorder()
    const resumed: Array<string> = []
    const polled = Deferred.makeUnsafe<void>()
    const hub = await Effect.runPromise(PubSub.unbounded<JournalEvent.Entry>())
    const attempted = await withExecutor(
      record,
      {
        journal: {
          changes: Effect.tap(PubSub.subscribe(hub), () => Deferred.succeed(record.subscribed, void 0))
        },
        engine: (engine) =>
          ({
            ...engine,
            poll: () => Deferred.succeed(polled, void 0).pipe(Effect.as(Option.some({ _tag: "Completed" }))),
            resume: (_flow: unknown, executionId: string) => Effect.sync(() => void resumed.push(executionId))
          }) as unknown as EngineService
      },
      () =>
        Effect.gen(function*() {
          yield* Deferred.await(record.subscribed)
          yield* PubSub.publish(hub, entry("run-settled", "control.run.resume"))
          yield* Deferred.await(polled)
          return resumed
        })
    )

    expect(attempted).toEqual([])
  })

  it("stops the bridge without stopping the executor when the journal subscription itself fails", async () => {
    const record = recorder()
    const result = await launched(record, { journal: { changes: Effect.die("the journal cannot publish changes") } })

    // The bridge is dead, so nothing would re-drive a parked run — but a
    // launch still runs to completion, which is the containment the catch
    // exists to buy.
    expect(result.acceptance).toBe("accepted")
    expect(result.status).toBe("completed")
  })
})

describe("the agent flow the executor registers", () => {
  it("carries an inert plan-time body: the registered execute is the behaviour", async () => {
    const record = recorder()
    const registered: Array<unknown> = []
    await withExecutor(
      record,
      {
        engine: (engine) =>
          ({
            ...engine,
            register: (flow: unknown, execute: unknown) => {
              registered.push(flow)
              return (engine.register as unknown as (f: unknown, e: unknown) => Effect.Effect<void, never, never>)(
                flow,
                execute
              )
            }
          }) as unknown as EngineService
      },
      () => Effect.void
    )

    expect(registered).toHaveLength(1)
    const flow = registered[0] as {
      readonly _tag: string
      readonly body: (payload: { readonly runId: string; readonly planId: string }) => unknown
    }
    expect(flow._tag).toBe("agent/run")
    // Inert means the body ignores its payload entirely and settles with
    // nothing: two different runs compile to the same node, and that node is
    // a bare success.
    expect(flow.body({ runId: "run-a", planId: "plan-a" })).toEqual(Node.succeed(undefined))
    expect(flow.body({ runId: "run-b", planId: "plan-b" })).toEqual(
      flow.body({ runId: "run-a", planId: "plan-a" })
    )
  })
})
