/**
 * The composition root, end to end: control → executor → durable engine.
 *
 * One scenario carries the definition of done. A planned agent flow is
 * approved and run through the real `Control` service; the production
 * executor accepts the launch and executes the cell loop on the real durable
 * engine; frame zero makes a tool call through the real QuickJS sandbox; an
 * operator steer admitted through `Control.steer` is delivered at the frame
 * boundary; frame one's `ask` parks the run as `waiting-approval`, is
 * approved through `Control.approve` with the exact payload the executor
 * journaled, and the resumed run replays its settled prefix and completes.
 *
 * The scenario runs twice: once against a scripted model that records every
 * provider request, and once against `RecordedModel` replaying that fixture —
 * which proves the composition is deterministic enough to be driven entirely
 * from a recording, and that the recording is consumed in full.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Control, ControlError, ControlLive, ControlRuntime, ControlSchema } from "@smthrs/control"
import * as CoreFlow from "@smthrs/core/Flow"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Jj from "@smthrs/jj"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import type * as Fixture from "@smthrs/testing/Fixture"
import type * as ModelLike from "@smthrs/testing/ModelLike"
import * as RecordedModel from "@smthrs/testing/RecordedModel"
import { Cause, Deferred, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const agentDescriptor = new Descriptor.FlowDescriptor({
  name: "agents/notes",
  description: "The notes agent.",
  body: new Descriptor.BodyRefMarkdown({ path: "/flows/agents/notes/flow.md", baseDirectory: "/flows/agents/notes" }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some("anthropic:test-model"),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: false,
  path: "/flows/agents/notes",
  frontmatter: {},
  provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
})

/** A flow that declares its own reasoning effort, overriding the host default. */
const effortDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/effort",
  path: "/flows/agents/effort",
  frontmatter: { effort: "low" }
})

const moduleDescriptor = new Descriptor.FlowDescriptor({
  ...agentDescriptor,
  name: "agents/module",
  body: new Descriptor.BodyRefModule({ path: "/flows/agents/module/flow.ts" }),
  path: "/flows/agents/module"
})

const descriptors = new Map([
  [agentDescriptor.name, agentDescriptor],
  [effortDescriptor.name, effortDescriptor],
  [moduleDescriptor.name, moduleDescriptor]
])

const registryService = Registry.makeNoop({
  list: () => Effect.succeed([agentDescriptor, effortDescriptor, moduleDescriptor]),
  visible: () => Effect.succeed([]),
  get: (name) =>
    descriptors.has(name)
      ? Effect.succeed(descriptors.get(name)!)
      : Effect.flatMap(Registry.makeNoop().get(name), () => Effect.die("unreachable")),
  getOption: (name) => Effect.succeed(Option.fromNullishOr(descriptors.get(name))),
  loadBody: (name) =>
    Effect.succeed(
      name === moduleDescriptor.name
        ? new Descriptor.FlowBodyModule({ path: "/flows/agents/module/flow.ts" })
        : new Descriptor.FlowBodyPrompt({ text: "Keep the note log tidy.", baseDirectory: "/flows/agents/notes" })
    )
})

const memoryFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "agents/notes",
    description: "The notes agent.",
    deployClass: false,
    // One valid wildcard, one valid exact pattern, and three malformed
    // entries the composition must drop rather than widen: no resource, a
    // pattern-less name, and an action outside the vocabulary.
    envelope: {
      capabilities: ["*:**", "fs:read:**", "fs:read", "single", "zz:yy:**"],
      flows: [],
      budget: {}
    }
  },
  {
    flowId: "agents/effort",
    description: "The notes agent, with its own declared reasoning effort.",
    deployClass: false,
    envelope: { capabilities: [], flows: [], budget: {} }
  },
  {
    flowId: "agents/module",
    description: "An agent seat over a module body, which the harness refuses.",
    deployClass: false,
    envelope: { capabilities: [], flows: [], budget: {} }
  },
  {
    flowId: "system/idle",
    description: "A flow no executor composition can run.",
    deployClass: false,
    envelope: { capabilities: [], flows: [], budget: {} }
  }
]

const noteFlow = CoreFlow.make({
  name: "note/save",
  description: "Save one line to the run's note log.",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ saved: Schema.Number }),
  effects: { reads: [], writes: ["/notes/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

const checkFlow = CoreFlow.make({
  name: "project/check",
  description: "Run the project's own check and report its exit code.",
  input: Schema.Struct({ command: Schema.String }),
  output: Schema.Struct({ exitCode: Schema.Number }),
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

const frameZero = `await ctx.call("project/check", { command: "npm test" })
const saved = await ctx.call("note/save", { text: "frame zero note" })
console.log("note saved")`

const frameOne = `const decision = await ctx.call("ask", { question: "publish the log?", options: ["yes", "no"] })
ctx.done("approved=" + decision.approved)`

const cellEvents = (source: string, id: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

interface Captured {
  readonly request: ModelRequest.ModelRequest
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
}

/** A scripted model that records the exact provider request of every frame. */
const capturing = (captured: Array<Captured>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const source = captured.length === 0 ? frameZero : frameOne
        const events = cellEvents(source, `cell-${captured.length}`)
        captured.push({ request, events })
        return Stream.fromIterable(events)
      })
  })

const principal: ControlSchema.Principal = { id: "operator", kind: "test", stampedAt: 1 }

const steerBody = "steer: mention the weather"

interface StackOptions {
  /** The scripted resolver installed as the composition's `SeatResolver`. */
  readonly resolve: SeatResolver.Service["resolve"]
  readonly notes: Array<string>
  /** Commands the project-check flow was actually asked to run. */
  readonly checks?: Array<string> | undefined
  readonly gate: Deferred.Deferred<void>
  /** Completes when the test tool enters its gate, before its side effect. */
  readonly toolStarted?: Deferred.Deferred<void> | undefined
  /** Omit the host flow sources entirely, exercising the executor's default. */
  readonly bare?: boolean | undefined
  /** The host's reasoning-effort default, beneath a flow's own `effort:`. */
  readonly reasoningEffort?: ModelRequest.ReasoningEffort | undefined
}

/**
 * The full production stack: the live control plane, the real executor, and
 * the SQLite-backed durable engine composed by `flows/NodeRuntime`. The
 * control test journal remains deterministic, while the executor-facing flow
 * runtime uses the same production storage and startup ordering as NodeControl.
 */
const stack = (options: StackOptions) => {
  const root = mkdtempSync(join(tmpdir(), "flows-agent-session-"))
  engineRoots.add(root)
  const journal = TestJournal.layer()
  const notifications = NotificationQueue.layer.pipe(Layer.provide(journal))
  const runtime = ControlRuntime.layerMemory({ flows: memoryFlows }).pipe(Layer.provide(NodeCrypto.layer))
  const registry = Layer.succeed(Registry.Registry)(registryService)
  const noteSource = FlowBinding.source("test/notes", [
    FlowBinding.make({
      flow: noteFlow,
      handler: (input) =>
        (options.toolStarted === undefined ? Effect.void : Deferred.succeed(options.toolStarted, void 0)).pipe(
          Effect.andThen(Deferred.await(options.gate)),
          Effect.andThen(Effect.sync(() => {
            options.notes.push(input.text)
            return { saved: options.notes.length }
          }))
        )
    })
  ])
  const checkSource = FlowBinding.source("test/check", [
    FlowBinding.make({
      flow: checkFlow,
      handler: (input) =>
        Effect.sync(() => {
          options.checks?.push(input.command)
          return { exitCode: 0 }
        })
    })
  ])
  const registration = AgentSession.layer({
    flows: options.bare === true ? undefined : [noteSource, checkSource],
    limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
    maxFrames: 4,
    reasoningEffort: options.reasoningEffort
  }).pipe(
    // The agent and the seat resolver are the executor's own dependencies;
    // everything else in its `Services` union comes from the engine stack.
    Layer.provide(Layer.merge(Agent.layer, SeatResolver.layer({ resolve: options.resolve })))
  )
  let snapshot = 0
  const jj = Jj.layerNoop({
    snapshot: () => Effect.succeed({ changeId: `snapshot-${snapshot++}` }),
    restore: () => Effect.void,
    diff: () => Effect.succeed("")
  })
  const engine = NodeRuntime.layer(
    {
      filename: join(root, "engine.db"),
      owner: { hostId: "agent-session-test" },
      isAlive: () => Effect.succeed(false)
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(Layer.provide([NodeFileSystem.layer, NodeCrypto.layer, jj]))
  return ControlLive.layer.pipe(
    Layer.provideMerge(engine),
    Layer.provideMerge(Layer.mergeAll(runtime, journal, notifications, registry))
  )
}

const engineRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...engineRoots].map((root) => rm(root, { recursive: true, force: true })))
  engineRoots.clear()
})

const seat = (model: Model.Model): SeatResolver.Service["resolve"] => (id) =>
  Effect.succeed(
    Seat.make({
      id,
      model,
      route,
      contextWindowTokens: SeatResolver.contextWindowTokensFor("test-model")
    })
  )

/**
 * Waits for a run to reach a status by yielding, bounded by a count of turns.
 *
 * The bound is a hang detector, not a schedule: every attempt is one in-memory
 * read plus a microtask, so a generous count still fails a genuinely stuck run
 * in milliseconds. Five hundred was not generous enough — the two-run failure
 * case below needs roughly four times that on an unloaded machine and had been
 * failing outright — and a poll budget that a correct run can exhaust reports a
 * red the code did not earn.
 */
const awaitStatus = (
  runtime: ControlRuntime.Service,
  runId: string,
  status: ControlSchema.RunStatus,
  attempts = 20_000
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const run = yield* runtime.getRun(runId)
    if (run.status === status) return
    if (attempts <= 0) {
      return yield* Effect.die(`run ${runId} never reached ${status} (still ${run.status})`)
    }
    yield* Effect.yieldNow
    return yield* awaitStatus(runtime, runId, status, attempts - 1)
  })

interface Outcome {
  readonly runId: string
  readonly requestedQuestion: string
  readonly grantTokens: ReadonlyArray<string>
  readonly agentTrail: ReadonlyArray<JournalEvent.Entry>
}

/**
 * Drives one complete run: plan → approve → run → steer → park on the ask →
 * approve the in-run request → resume → completed.
 *
 * The gate releases the frame-zero tool call only after the steer is
 * admitted, so the frame-boundary drain deterministically sees it.
 */
const drive = (
  gate: Deferred.Deferred<void>,
  decision: "approve" | "deny" = "approve"
): Effect.Effect<Outcome, unknown, Control.Control | ControlRuntime.ControlRuntime | Journal.Journal> =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const runtime = yield* ControlRuntime.ControlRuntime
    const journal = yield* Journal.Journal

    const card = yield* control.plan({ flowId: "agents/notes", input: { topic: "standups" } })
    yield* control.approve(card.approval)
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: "run:notes"
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
      return yield* Effect.die("expected an accepted run")
    }
    const runId = receipt.runId

    yield* control.steer({
      runId,
      message: { messageId: "steer-1", runId, body: steerBody, principal, createdAt: 1 },
      idempotencyKey: "steer:1"
    })
    yield* Deferred.succeed(gate, void 0)

    // Frame one's ask parks the run and journals the exact approval payload
    // an operator replays through `flows approve`.
    const requested = yield* control.watch({ runId }).pipe(
      Stream.filter((event) => event.kind === "control.approval.requested"),
      Stream.take(1),
      Stream.runCollect
    )
    const requestedPayload = requested[0]?.payload as {
      readonly question: string
      readonly payload: unknown
    }
    yield* awaitStatus(runtime, runId, "waiting-approval")

    const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(requestedPayload.payload)
    yield* decision === "approve" ? control.approve(approval) : control.deny(approval)
    yield* control.resume({ runId, idempotencyKey: "resume:1" })
    yield* awaitStatus(runtime, runId, "completed")

    const grants = yield* runtime.grants
    yield* journal.flush
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1_000 })
    return {
      runId,
      requestedQuestion: requestedPayload.question,
      grantTokens: grants.map((grant) => grant.tokenId),
      agentTrail: page.entries.filter((entry) => entry.eventType.startsWith("control.agent."))
    }
  })

const textOf = (request: ModelRequest.ModelRequest): string =>
  request.messages.flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .join("\n")

describe("AgentSession", () => {
  it("waits through an accepted control row before driving the engine", async () => {
    let reads = 0
    await expect(Effect.runPromise(
      AgentSession.waitForRunning(
        () => Effect.sync(() => (reads++ === 0 ? "accepted" : "running")),
        "run-wait",
        1,
        Effect.yieldNow
      )
    )).resolves.toBe(true)
    expect(reads).toBe(2)
    await expect(
      Effect.runPromise(AgentSession.waitForRunning(() => Effect.succeed("cancelled"), "run-cancelled", 1))
    ).resolves.toBe(false)
    await expect(
      Effect.runPromise(AgentSession.waitForRunning(() => Effect.succeed("accepted"), "run-stuck", 0))
    ).rejects.toMatchObject({ code: "launch_failed", runId: "run-stuck" })
  })

  it("waits for a parked execution publication before resuming it", async () => {
    let polls = 0
    const parked = await Effect.runPromise(
      AgentSession.waitForParked(
        () => Effect.sync(() => (++polls === 1 ? Option.none() : Option.some({ _tag: "Suspended" }))),
        1
      )
    )
    expect(parked).toBe(true)
    expect(polls).toBe(2)
    await expect(Effect.runPromise(AgentSession.waitForParked(() => Effect.succeed(Option.none()), 0)))
      .resolves.toBe(false)
  })

  it("keeps cancellation and registration failures contained at the executor boundary", async () => {
    await expect(Effect.runPromise(AgentSession.preserveDriverInterrupt(() => Effect.fail("interrupted"))))
      .resolves.toBeUndefined()
    const failure = await Effect.runPromise(
      Effect.flip(AgentSession.registerDriver(() => Effect.fail("missing run"), "run-registration"))
    )
    expect(failure).toMatchObject({
      runId: "run-registration",
      message: "The run driver could not be registered for cancellation",
      cause: "missing run"
    })
    let failedDetail = ""
    await expect(Effect.runPromise(AgentSession.settleDriverFailure(
      Cause.fail("engine failed"),
      "run-failed",
      (detail) => Effect.sync(() => void (failedDetail = detail))
    )))
      .resolves.toBeUndefined()
    expect(failedDetail).toContain("engine failed")
    const statusFailure = await Effect.runPromiseExit(
      AgentSession.settleDriverFailure(
        Cause.fail("engine failed"),
        "run-failed",
        () => Effect.fail("status unavailable")
      )
    )
    expect(statusFailure).toMatchObject({ _tag: "Failure" })
    const interrupted = await Effect.runPromiseExit(
      AgentSession.settleDriverFailure(Cause.interrupt(1), "run-interrupted", () => Effect.void)
    )
    expect(interrupted._tag).toBe("Failure")
  })

  it("drives a 2-frame run through control → executor → engine, then replays it from the recorded fixture", {
    timeout: 30_000
  }, async () => {
    // Pass one: a scripted model records the exact request of every frame.
    const captured: Array<Captured> = []
    const notes: Array<string> = []
    const checks: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* drive(gate).pipe(
          Effect.provide(stack({ resolve: seat(capturing(captured)), notes, checks, gate }))
        )
      }).pipe(Effect.scoped) as Effect.Effect<Outcome>
    )

    // Two provider calls, one per frame, and the resumed attempt replayed
    // both as sealed steps instead of asking the provider again.
    expect(captured).toHaveLength(2)
    // The host check flow ran exactly once, from the cell that called it: the
    // controller has no private way to run commands of its own.
    expect(checks).toEqual(["npm test"])
    // Per-call latency is journaled next to usage, so a benchmark can measure
    // seconds per call and not only per run.
    // At least one per frame; the park and its resumed attempt re-emit the
    // frames they replay.
    const settled = outcome.agentTrail.filter((entry) => entry.eventType === "control.agent.model-settled")
    expect(settled.length).toBeGreaterThanOrEqual(2)
    expect(
      settled.every((entry) =>
        typeof (entry.payload as { readonly durationMillis?: unknown }).durationMillis === "number"
      )
    ).toBe(true)
    // The steer admitted through Control.steer reached frame one's context at
    // the frame boundary, alongside the cell's own continuation insert.
    const frameOneText = textOf(captured[1]!.request)
    expect(frameOneText).toContain("note saved")
    expect(frameOneText).toContain(steerBody)
    // The QuickJS-sandboxed tool call executed exactly once across the park
    // and its resumed attempt.
    expect(notes).toEqual(["frame zero note"])
    // The in-run approval was requested with the question the cell asked, and
    // approving it installed the grant the resumed ask read.
    expect(outcome.requestedQuestion).toBe("publish the log?")
    expect(outcome.grantTokens.some((token) => token.startsWith(`ask/${outcome.runId}/`))).toBe(true)
    expect(outcome.agentTrail.length).toBeGreaterThan(0)
    expect(outcome.agentTrail.every((entry) => typeof (entry.payload as { readonly at?: unknown }).at === "number"))
      .toBe(true)

    // Pass two: the same scenario, driven entirely from the recording.
    const fixture: Fixture.Fixture = {
      calls: captured.map((call) => ({
        request: call.request as unknown as ModelLike.ModelRequestLike,
        model: "test-model",
        events: call.events as unknown as ReadonlyArray<ModelLike.ModelEventLike>
      }))
    }
    const replayNotes: Array<string> = []
    const replayed = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const replay = yield* RecordedModel.make(fixture)
        const model = Model.make({ stream: replay.model.stream as Model.Model["stream"] })
        const driven = yield* drive(gate).pipe(
          Effect.provide(stack({ resolve: seat(model), notes: replayNotes, gate }))
        )
        const unconsumed = yield* replay.controller.unconsumed()
        return { driven, unconsumed }
      }).pipe(Effect.scoped) as Effect.Effect<{
        driven: Outcome
        unconsumed: ReadonlyArray<Fixture.RecordedCall>
      }>
    )

    expect(replayNotes).toEqual(["frame zero note"])
    expect(replayed.driven.requestedQuestion).toBe("publish the log?")
    expect(replayed.driven.agentTrail.length).toBeGreaterThan(0)
    expect(
      replayed.driven.agentTrail.every((entry) => typeof (entry.payload as { readonly at?: unknown }).at === "number")
    ).toBe(true)
    // Every recorded call was matched and consumed: the recording drove the
    // whole loop, nothing was unscripted and nothing was left over.
    expect(replayed.unconsumed).toEqual([])
  })

  it("settles resume events for runs it never launched without holding the bridge", { timeout: 30_000 }, async () => {
    const notes: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* Effect.gen(function*() {
          const journal = yield* Journal.Journal
          // Three resume events for runs no executor in this process launched
          // — a paused system flow, another process's run in a shared control
          // database. Without the not-found fast path each would hold the
          // single-concurrency resume bridge for its whole retry budget,
          // starving the genuine resume below past its completion wait.
          for (const foreign of ["foreign-1", "foreign-2", "foreign-3"]) {
            yield* journal.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: JournalEvent.RunId.make(foreign),
                sourceId: JournalEvent.SourceId.make("/test/foreign-control"),
                eventType: "control.run.resume",
                payload: { runId: foreign, status: "accepted" }
              })
            )
          }
          return yield* drive(gate)
        }).pipe(Effect.provide(stack({ resolve: seat(capturing([])), notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<Outcome>
    )

    expect(outcome.requestedQuestion).toBe("publish the log?")
    expect(notes).toEqual(["frame zero note"])
  })

  it("accepts nothing it cannot execute: a flow without an agent body stays pending", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "system/idle", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:idle"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          const events = yield* control.watch({ runId: receipt.runId }).pipe(
            Stream.take(2),
            Stream.runCollect
          )
          const run = yield* runtime.getRun(receipt.runId)
          return { kinds: events.map((event) => event.kind), status: run.status }
        }).pipe(Effect.provide(stack({ resolve: seat(capturing([])), notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<{ kinds: ReadonlyArray<string>; status: string }, unknown>
    )

    expect(result.kinds).toEqual(["control.run.accepted", "control.run.pending"])
    expect(result.status).toBe("accepted")
  })

  it("delivers a denial to the resumed ask instead of parking forever", async () => {
    const notes: Array<string> = []
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        return yield* drive(gate, "deny").pipe(
          Effect.provide(stack({ resolve: seat(capturing([])), notes, gate }))
        )
      }).pipe(Effect.scoped) as Effect.Effect<Outcome>
    )

    // The denial resolved the token without installing a grant, so the
    // resumed ask answered `denied` and the run still completed.
    expect(outcome.grantTokens.some((token) => token.startsWith("ask/"))).toBe(false)
    expect(notes).toEqual(["frame zero note"])
  })

  it("durably cancels a driver blocked in a tool before its side effect runs", async () => {
    const notes: Array<string> = []
    const status = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const toolStarted = yield* Deferred.make<void>()
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "agents/notes", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:cancelled-tool"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          // Wait until the first cell has entered `note/save`'s gate. This
          // makes the driver interruption deterministic rather than racing
          // the executor's asynchronous launch.
          yield* Deferred.await(toolStarted)
          // Cancelling must reach the durable engine, not merely change the
          // control row.
          yield* control.cancel({ runId: receipt.runId, idempotencyKey: "cancel:blocked-tool" })
          yield* Effect.yieldNow
          yield* Deferred.succeed(gate, void 0)
          yield* awaitStatus(runtime, receipt.runId, "cancelled")
          return (yield* runtime.getRun(receipt.runId)).status
        }).pipe(Effect.provide(stack({ resolve: seat(capturing([])), notes, gate, toolStarted })))
      }).pipe(Effect.scoped) as Effect.Effect<string>
    )

    expect(status).toBe("cancelled")
    expect(notes).toEqual([])
  })

  it("leaves a seated flow with a module body pending: only prompt flows run on the cell harness", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const card = yield* control.plan({ flowId: "agents/module", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:module"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          const run = yield* runtime.getRun(receipt.runId)
          return run.status
        }).pipe(Effect.provide(stack({ resolve: seat(capturing([])), notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<string, unknown>
    )

    expect(result).toBe("accepted")
  })

  it("journals a bounded cause when the model fails, for an empty and an absent input", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        const failing = Model.make({
          stream: () =>
            Stream.fail(
              new ModelError.ModelError({ code: "authentication", message: "invalid credential ".repeat(400) })
            )
        })
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          const journal = yield* Journal.Journal
          const results: Array<{ readonly status: string; readonly failed: JournalEvent.Entry }> = []
          // One empty-object input and one null input: both render the bare
          // prompt, and both runs settle as failed when the provider errors.
          for (const input of [{}, null]) {
            const card = yield* control.plan({ flowId: "agents/notes", input })
            yield* control.approve(card.approval)
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: `run:failing:${card.planId}`
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
              return yield* Effect.die("expected an accepted run")
            }
            yield* awaitStatus(runtime, receipt.runId, "failed")
            const page = yield* journal.entries({
              runId: JournalEvent.RunId.make(receipt.runId),
              limit: 100
            })
            const failed = page.entries.find((entry) => entry.eventType === "control.run.failed")
            if (failed === undefined) return yield* Effect.die("the failed run was not journaled")
            results.push({ status: (yield* runtime.getRun(receipt.runId)).status, failed })
          }
          return results
        }).pipe(Effect.provide(stack({ resolve: seat(failing), notes, gate, bare: true })))
      }).pipe(Effect.scoped) as Effect.Effect<
        ReadonlyArray<{ readonly status: string; readonly failed: JournalEvent.Entry }>,
        unknown
      >
    )

    expect(results.map((result) => result.status)).toEqual(["failed", "failed"])
    for (const result of results) {
      const payload = result.failed.payload as { readonly cause?: unknown }
      expect(typeof payload.cause).toBe("string")
      expect((payload.cause as string).length).toBe(4_096)
    }
  })

  it("requests the flow's declared effort, and the host default where a flow declares none", async () => {
    const requests: Array<ModelRequest.ModelRequest> = []
    // A model that records its request and then refuses: the effort travels
    // in the first frame's request, so the run never has to complete.
    const recording = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          requests.push(request)
          return Stream.fail(new ModelError.ModelError({ code: "authentication", message: "no credential" }))
        })
    })

    await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const runtime = yield* ControlRuntime.ControlRuntime
          for (const flowId of ["agents/notes", "agents/effort"]) {
            const card = yield* control.plan({ flowId, input: {} })
            yield* control.approve(card.approval)
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: `run:effort:${flowId}`
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
              return yield* Effect.die("expected an accepted run")
            }
            // The durable event is the synchronization point. A bounded
            // `yieldNow` polling loop can exhaust while the run fiber is still
            // publishing its terminal projection on a busy test worker.
            yield* control.watch({ runId: receipt.runId }).pipe(
              Stream.filter((event) => event.kind === "control.run.failed"),
              Stream.take(1),
              Stream.runDrain
            )
            expect((yield* runtime.getRun(receipt.runId)).status).toBe("failed")
          }
        }).pipe(
          Effect.provide(
            stack({ resolve: seat(recording), notes, gate, bare: true, reasoningEffort: "medium" })
          )
        )
      }).pipe(Effect.scoped) as Effect.Effect<void, unknown>
    )

    expect(requests.map((request) => request.params.reasoningEffort)).toEqual(["medium", "low"])
  })

  it("refuses a launch whose seat cannot be resolved", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const notes: Array<string> = []
        const resolve: SeatResolver.Service["resolve"] = (seatId) =>
          Effect.fail(new Seat.SeatUnresolved({ seat: seatId, message: "No API key is configured" }))
        return yield* Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "agents/notes", input: {} })
          yield* control.approve(card.approval)
          return yield* Effect.flip(control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "run:unresolved"
          }))
        }).pipe(Effect.provide(stack({ resolve, notes, gate })))
      }).pipe(Effect.scoped) as Effect.Effect<unknown>
    )

    expect(error).toBeInstanceOf(ControlError.LaunchFailed)
    expect((error as ControlError.LaunchFailed).message).toBe("No API key is configured")
  })
})
