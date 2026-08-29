import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Cause, Effect, Exit, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as Cell from "../src/Cell.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as Plan from "../src/Plan.ts"

const assistantMessage = ModelRequest.Message.assistant("done", { stopReason: "stop" })
const cellSource = Cell.source("return { intent: \"complete\", state: null, output: \"done\" }")
const callIdentity = new Cell.CallIdentity({
  session: "session-1",
  frame: 3,
  cell: cellSource.digest,
  ordinal: 0,
  declaration: "declaration-digest",
  layers: ["composition-1"]
})
const flowCall = new Cell.Call({
  flowName: "fs/list",
  input: { path: "." },
  capabilities: ["fs:read:."],
  effects: { reads: ["."], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  placement: Option.some("local"),
  identity: callIdentity
})
const child = new Plan.Child({
  flowName: "read-pr",
  callId: "call-1",
  args: { number: 42 },
  capabilities: ["fs:read:/workspace/**"],
  effects: {
    reads: ["/workspace/**"],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  },
  placement: Option.some("local")
})
const batch = new Plan.Batch({ children: [child] })
const permissionRequest = new Permission.PermissionRequired({
  requestId: "permission-1",
  capability: new Capability.Capability({
    action: "fs:read",
    resource: "/workspace"
  }),
  tier: "sealed",
  meta: {}
})

describe("AgentEvent", () => {
  it("round-trips every stable event variant", () => {
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.DisciplineArmed({
        eventType: "flows.harness.discipline-armed.v1",
        readOnlyCap: 3,
        maxFrames: 100,
        approvalChannel: true,
        modelCallMs: 300_000,
        repeatCap: 4,
        narrowingCap: 1,
        unmovedCap: 1,
        unresolvedCap: 1,
        calls: 8,
        memoryBytes: 1024,
        steps: 10_000,
        timeMs: 500,
        totalMs: 2_000,
        callMs: 250
      }),
      new AgentEvent.CellProduced({
        eventType: "flows.harness.cell-produced.v1",
        cell: cellSource,
        blocks: 3
      }),
      new AgentEvent.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: flowCall
      }),
      new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: flowCall.flowName,
        identity: callIdentity,
        result: new Cell.CallResult({ outcome: "success", value: ["alpha.md"] })
      }),
      new AgentEvent.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: cellSource.digest,
        outcome: new Cell.Settled({
          transition: new Cell.Complete({ state: null, output: "done", reason: "the tests pass" })
        })
      }),
      new AgentEvent.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: cellSource.digest,
        outcome: new Cell.Raised({ name: "TypeError", message: "x is not a function" })
      }),
      new AgentEvent.CellSettled({
        eventType: "flows.harness.cell-settled.v1",
        cell: "",
        outcome: new Cell.Rejected({ code: "no_cell", message: "emit a cell" })
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Continue({
          state: { step: 1 },
          context: [new Cell.ContextEntry({ role: "user", text: "keep this" })],
          justification: "the workspace is still being read"
        })
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Park({ state: { step: 1 }, reason: "waiting-input", message: "choose a branch" })
      }),
      new AgentEvent.Suspended({
        eventType: "flows.harness.suspended.v1",
        reason: new EngineLike.SuspendReason({
          code: "waiting-quota",
          message: "the seat is rate limited",
          details: { retryAfterMs: 1000 }
        })
      }),
      new AgentEvent.TurnOpened({
        eventType: "flows.harness.turn-opened.v1",
        seat: "sdk:model",
        modelParams: ModelRequest.GenerationParams.make({ reasoningEffort: "low" }),
        activeToolNames: ["flow"],
        contextDigest: "context-digest"
      }),
      new AgentEvent.ModelDelta({
        eventType: "flows.harness.model-delta.v1",
        delta: ModelEvent.ModelEvent.TextDelta({
          type: "text-delta",
          id: "text-1",
          text: "hello"
        })
      }),
      new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: assistantMessage,
        usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 2 })
      }),
      new AgentEvent.CompactionSettled({
        eventType: "flows.harness.compaction-settled.v1",
        replacedPrefixDigest: "prefix-digest",
        summary: assistantMessage
      }),
      new AgentEvent.SteeringDrained({
        eventType: "flows.harness.steering-drained.v1",
        messages: [ModelRequest.Message.user("continue")]
      }),
      new AgentEvent.TurnClosed({
        eventType: "flows.harness.turn-closed.v1",
        stopReason: "tool-calls",
        outcome: "continue"
      }),
      new AgentEvent.PermissionRequired({
        eventType: "flows.harness.permission-required.v1",
        request: permissionRequest
      }),
      new AgentEvent.Aborted({
        eventType: "flows.harness.aborted.v1",
        reason: "interrupted"
      }),
      new AgentEvent.NarrowedDemanded({
        eventType: "flows.harness.narrowed-demanded.v1",
        flow: "bash",
        broader: "{\"command\":\"check suite\"}",
        narrower: "{\"command\":\"check suite -only one\"}",
        broaderDigest: "digest-before",
        currentDigest: "digest-after",
        nextFrame: 7
      }),
      new AgentEvent.UnmovedDemanded({
        eventType: "flows.harness.unmoved-demanded.v1",
        openedDigest: "digest-opened",
        currentDigest: "digest-opened",
        nextFrame: 7
      }),
      new AgentEvent.UnresolvedDemanded({
        eventType: "flows.harness.unresolved-demanded.v1",
        flow: "bash",
        failed: "{\"command\":\"check suite\"}",
        instead: "{\"command\":\"check suite -only one\"}",
        currentDigest: "digest-after",
        nextFrame: 7
      }),
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: assistantMessage
      })
    ]

    for (const event of events) {
      expect(
        Schema.decodeUnknownSync(AgentEvent.AgentEvent)(
          Schema.encodeSync(AgentEvent.AgentEvent)(event)
        )
      ).toEqual(event)
    }
  })

  it("round-trips the same variants with every optional field absent", () => {
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      new AgentEvent.DisciplineArmed({
        eventType: "flows.harness.discipline-armed.v1",
        readOnlyCap: 0,
        maxFrames: 1,
        approvalChannel: false,
        modelCallMs: 0,
        repeatCap: 0,
        narrowingCap: 0,
        unmovedCap: 0,
        unresolvedCap: 0
      }),
      new AgentEvent.Suspended({
        eventType: "flows.harness.suspended.v1",
        reason: new EngineLike.SuspendReason({ code: "permission-required", message: "fs:write is not granted" })
      }),
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Complete({ state: null, output: "" })
      })
    ]

    for (const event of events) {
      const decoded = Schema.decodeUnknownSync(AgentEvent.AgentEvent)(
        Schema.encodeSync(AgentEvent.AgentEvent)(event)
      )
      expect(decoded).toEqual(event)
      // An absent optional stays absent across the round trip: a key carrying
      // an explicit `undefined` is a different journal payload.
      expect(Object.keys(decoded)).toEqual(Object.keys(event))
    }
    expect("calls" in events[0]!).toBe(false)
    expect("verification" in events[1]!).toBe(false)
  })

  it("defaults an absent duration to zero rather than rejecting the older payload", () => {
    const settled = new AgentEvent.ModelSettled({
      eventType: "flows.harness.model-settled.v1",
      message: assistantMessage,
      usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 2 })
    })
    const encoded = { ...Schema.encodeSync(AgentEvent.AgentEvent)(settled) as Record<string, unknown> }
    delete encoded["durationMillis"]

    const decoded = Schema.decodeUnknownSync(AgentEvent.AgentEvent)(encoded)

    expect(settled.durationMillis).toBe(0)
    expect(decoded._tag === "model-settled" ? decoded.durationMillis : undefined).toBe(0)
  })

  it("refuses a payload that is not one of the union's tags", () => {
    const decoded = Schema.decodeUnknownResult(AgentEvent.AgentEvent)({
      _tag: "not-an-event",
      eventType: "flows.harness.not-an-event.v1"
    })

    expect(decoded._tag).toBe("Failure")
  })
})

describe("HarnessError", () => {
  it("constructs every stable code", () => {
    const codes = [
      "assembly_failed",
      "render_failed",
      "projection_failed",
      "model_failed",
      "elaboration_failed",
      "engine_failed",
      "invalid_step",
      "lazy_tool_prompt_metadata",
      "aborted",
      "suspended",
      "adapter_spawn_failed",
      "adapter_quota_exhausted",
      "adapter_session_lost",
      "adapter_config_invalid",
      "adapter_auth_failed",
      "adapter_protocol_error",
      "adapter_binary_missing",
      "adapter_unsupported",
      "adapter_structured_output_failed",
      "unknown"
    ] as const

    for (const code of codes) {
      const error = new HarnessError({ code, message: code })
      expect(error.code).toBe(code)
      expect(error._tag).toBe("/harness/HarnessError")
    }
  })
})

describe("EngineLike", () => {
  it("resolves its noop layer and fails unavailable operations cleanly", async () => {
    const service = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* EngineLike.EngineLike
      }).pipe(Effect.provide(EngineLike.layerNoop()))
    )
    const request = ModelRequest.ModelRequest.make({
      modelId: "model",
      system: [],
      messages: [],
      tools: [],
      params: {}
    })

    const sealExit = await Effect.runPromiseExit(
      Stream.runDrain(service.sealStep({
        request,
        keyMaterial: {
          version: "flows/key-material/v1",
          kind: "sealed",
          body: request,
          inputs: [{ _tag: "Literal", value: { contextDigest: "context-digest" } }],
          layers: ["model:test"],
          capabilities: ["model:call:provider/model"],
          effects: undefined,
          placement: undefined
        }
      }))
    )
    const spliceExit = await Effect.runPromiseExit(Stream.runDrain(service.splice(batch)))
    const suspendExit = await Effect.runPromiseExit(
      service.suspend(
        new EngineLike.SuspendReason({
          code: "engine",
          message: "test"
        })
      )
    )

    expect(sealExit._tag).toBe("Failure")
    expect(spliceExit._tag).toBe("Failure")
    expect(suspendExit._tag).toBe("Failure")
  })

  it("refuses a call and never performs a recorded read", async () => {
    const service = EngineLike.makeNoop()
    let executed = false

    const callExit = await Effect.runPromiseExit(service.call(flowCall))
    const recordExit = await Effect.runPromiseExit(
      service.record({
        name: "steering-drain",
        identity: { session: "session-1", frame: 1, boundary: "turn-1" },
        success: Schema.String,
        execute: Effect.sync(() => {
          executed = true
          return "drained"
        })
      })
    )

    // A stub that ran `execute` would perform the nondeterministic read the
    // boundary exists to journal, so refusing has to happen before it.
    expect(executed).toBe(false)
    expect(Exit.isFailure(callExit) ? Cause.squash(callExit.cause) : undefined).toMatchObject({
      _tag: "/harness/HarnessError",
      code: "engine_failed",
      message: "call is unavailable"
    })
    expect(Exit.isFailure(recordExit) ? Cause.squash(recordExit.cause) : undefined).toMatchObject({
      code: "engine_failed",
      message: "record is unavailable"
    })
  })

  it("reports a stub as pinning nothing rather than as failing to pin", async () => {
    // The same shape `observe` takes, and for the same reason: a host with no
    // workspace has nothing to pin, and the controller turns "nothing pinned"
    // into a catchable refusal the cell can route around. Failing here would
    // turn a host that simply has no tree into a failed run.
    const pinned = await Effect.runPromise(
      EngineLike.makeNoop().capture({
        id: "cp-0-0",
        identity: { session: "session-1", frame: 0, boundary: "cell-digest" }
      })
    )

    expect(Option.isNone(pinned)).toBe(true)
  })

  it("reports a refused suspend as suspended rather than as an engine failure", async () => {
    const exit = await Effect.runPromiseExit(
      EngineLike.makeNoop().suspend(new EngineLike.SuspendReason({ code: "waiting-input", message: "test" }))
    )

    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
      code: "suspended",
      message: "suspend is unavailable"
    })
  })

  it("replaces only the overridden operation and leaves the rest unavailable", async () => {
    const settled = new Cell.CallResult({ outcome: "success", value: ["alpha.md"] })
    const service = EngineLike.makeNoop({ call: () => Effect.succeed(settled) })

    const called = await Effect.runPromise(service.call(flowCall))
    const recordExit = await Effect.runPromiseExit(
      service.record({
        name: "steering-drain",
        identity: { frame: 0, boundary: "turn-1" },
        success: Schema.String,
        execute: Effect.succeed("drained")
      })
    )

    expect(called).toStrictEqual(settled)
    expect(Exit.isFailure(recordExit)).toBe(true)
  })

  it("provides an overridden stub through its layer", async () => {
    const recorded = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* EngineLike.EngineLike
        return yield* engine.record({
          name: "steering-drain",
          identity: { session: "session-1", frame: 2, boundary: "turn-2" },
          success: Schema.String,
          execute: Effect.succeed("drained")
        })
      }).pipe(
        Effect.provide(EngineLike.layerNoop({ record: (boundary) => boundary.execute }))
      )
    )

    expect(recorded).toBe("drained")
  })

  it("provides a complete implementation through make and layer", async () => {
    const settled = new Cell.CallResult({ outcome: "failure", value: null, message: "no such flow" })
    const implementation = EngineLike.make({
      ...EngineLike.makeNoop(),
      call: () => Effect.succeed(settled)
    })

    const called = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* EngineLike.EngineLike
        return yield* engine.call(flowCall)
      }).pipe(Effect.provide(EngineLike.layer(implementation)))
    )

    expect(called).toStrictEqual(settled)
  })

  it("keeps every stable suspend reason code decodable", () => {
    const codes = ["permission-required", "waiting-quota", "waiting-input", "waiting-event", "engine"] as const

    for (const code of codes) {
      const reason = new EngineLike.SuspendReason({ code, message: code })
      expect(
        Schema.decodeUnknownSync(EngineLike.SuspendReason)(Schema.encodeSync(EngineLike.SuspendReason)(reason))
      ).toEqual(reason)
    }
    expect(Schema.decodeUnknownResult(EngineLike.SuspendReason)({ code: "nope", message: "x" })._tag).toBe("Failure")
  })
})
