import { describe, it } from "@effect/vitest"
import { Effects, Flow, Graph, Node } from "@smthrs/core"
import * as TestRuntime from "@smthrs/core/TestRuntime"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as WithApproval from "../src/WithApproval.ts"

const ApprovalInput = Schema.Struct({
  input: Schema.Unknown,
  reason: Schema.String,
  scope: Schema.String
})

type ExecutableFlow = Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown>

// The core evaluator executes the wrapper's actual AST and continuations. Its
// resolver owns flow boundaries: validate declared outputs and preserve Effect
// causes. These fixtures are synchronous; no durable host is involved.
const execute = (
  flow: Flow.Any,
  input: unknown,
  dynamic: () => Effect.Effect<unknown, unknown>
): Effect.Effect<unknown, unknown> =>
  Effect.suspend(() => {
    const implementation = (flow as ExecutableFlow).body
    if (implementation === undefined) return Effect.die("Missing test flow body")
    const result = TestRuntime.evaluate(implementation(input), (request) => {
      const exit = Effect.runSyncExit(
        request._tag === "FlowCall"
          ? execute(request.flow as Flow.Any, request.input, dynamic)
          : dynamic()
      )
      return Exit.isFailure(exit) ? Result.fail(exit.cause) : Result.succeed(exit.value)
    })
    if (Result.isFailure(result)) {
      return Cause.isCause(result.failure) ? Effect.failCause(result.failure) : Effect.fail(result.failure)
    }
    return Schema.decodeUnknownEffect((flow as ExecutableFlow).output)(result.success)
  })

const gated = (decision: Effect.Effect<unknown, unknown>) => {
  const input = { release: "v1" }
  const approvalInputs: Array<unknown> = []
  const innerInputs: Array<unknown> = []
  const trace: Array<string> = []
  const inner = Flow.make({
    name: "publish",
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: (input) => {
      trace.push("inner")
      innerInputs.push(input)
      return Node.succeed(input)
    }
  })
  const approval = Flow.make({
    name: "human-approval",
    input: ApprovalInput,
    output: WithApproval.Approved,
    body: (input) => {
      approvalInputs.push(input)
      return Node.dynamic({ output: WithApproval.Approved })
    }
  })
  const wrapper = WithApproval.withApproval(inner, { reason: "publish release", approval })
  const run = execute(wrapper, input, () => {
    trace.push("approval")
    return decision.pipe(Effect.tap(() => Effect.sync(() => trace.push("approved"))))
  })
  return { input, approvalInputs, innerInputs, trace, run }
}

describe("WithApproval", () => {
  it("runs a caller-supplied approval flow before the inner flow", () => {
    const inner = Flow.make({
      name: "publish",
      input: Schema.String,
      output: Schema.String,
      capabilities: ["release:publish"],
      effects: Effects.make({
        reads: [],
        writes: ["release"],
        mode: "expected",
        onConflict: "serialize",
        tier: "irreversible"
      }),
      body: () => Node.dynamic({ output: Schema.String })
    })
    const approval = Flow.make({
      name: "human-approval",
      input: Schema.Unknown,
      output: WithApproval.Approved,
      body: () => Node.dynamic({ output: WithApproval.Approved })
    })
    const approved = WithApproval.withApproval(inner, {
      reason: "publish release",
      approval
    })
    const graph = Graph.build(approved, "v1")

    expect((approved as typeof inner).name).toBe("withApproval(publish)")
    expect((approved as typeof inner).capabilities).toEqual(["release:publish"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Dynamic")).toHaveLength(2)
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(3)
    expect(Graph.diagnostics(graph)).toEqual([])

    const [, approvalCall, gatedCall] = Graph.nodes(graph).filter((node) => node.kind === "FlowCall")
    expect(approvalCall!.keyMaterial.inputs).toContainEqual({
      _tag: "Literal",
      value: { input: "v1", reason: "publish release", scope: "run" }
    })
    expect(gatedCall!.keyMaterial.inputs).toContainEqual({ _tag: "Literal", value: "v1" })
    expect(gatedCall!.dependencies).toContain(approvalCall!.id)
    expect(Graph.edges(graph)).toContainEqual({
      from: approvalCall!.id,
      to: gatedCall!.id,
      reason: "continuation"
    })
  })

  it.effect("rejects denial on the typed schema-error channel", () =>
    Effect.gen(function*() {
      // The flow declares Approved, but its dynamic implementation violates it.
      const fixture = gated(Effect.succeed("denied"))
      const failure = yield* fixture.run.pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "SchemaError" })
      expect(Schema.isSchemaError(failure)).toBe(true)
      expect(fixture.approvalInputs).toHaveLength(1)
      expect(fixture.innerInputs).toEqual([])
    }))

  it.effect("leaves the inner flow unstarted when approval fails", () =>
    Effect.gen(function*() {
      const error = new PatternError({ code: "exhausted", message: "Approval unavailable" })
      const fixture = gated(Effect.fail(error))
      const failure = yield* fixture.run.pipe(Effect.flip)

      expect(failure).toBe(error)
      expect(fixture.trace).toEqual(["approval"])
      expect(fixture.innerInputs).toEqual([])
    }))

  it.effect("leaves the inner flow unstarted when approval is interrupted", () =>
    Effect.gen(function*() {
      const fixture = gated(Effect.interrupt)
      const exit = yield* Effect.exit(fixture.run)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(fixture.trace).toEqual(["approval"])
      expect(fixture.innerInputs).toEqual([])
    }))

  it.effect("invokes the inner flow exactly once with the original input after approval", () =>
    Effect.gen(function*() {
      const fixture = gated(Effect.succeed("approved"))
      const result = yield* fixture.run

      expect(result).toBe(fixture.input)
      expect(fixture.approvalInputs).toEqual([{
        input: fixture.input,
        reason: "publish release",
        scope: "run"
      }])
      expect(fixture.innerInputs).toHaveLength(1)
      expect(fixture.innerInputs[0]).toBe(fixture.input)
      expect(fixture.trace).toEqual(["approval", "approved", "inner"])
    }))

  it("accepts an approval flow whose input exactly describes the call payload", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const approval = Flow.make({
      input: ApprovalInput,
      output: WithApproval.Approved,
      body: () => Node.succeed("approved" as const)
    })
    const approved = WithApproval.withApproval(inner, { reason: "publish", approval })

    expect(Graph.diagnostics(Graph.build(approved, "v1"))).toEqual([])
  })

  it("names the input side and both schema tags for an incompatible approval input", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const approval = Flow.make({
      input: Schema.String,
      output: WithApproval.Approved,
      body: () => Node.succeed("approved" as const)
    })

    expect(() => WithApproval.withApproval(inner, { reason: "publish", approval })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The bound flow has an incompatible input schema: expected Objects, received String"
      })
    )
  })

  it("rejects an approval flow whose output permits denial", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const approval = Flow.make({
      input: Schema.Unknown,
      output: Schema.String,
      body: () => Node.succeed("approved")
    })

    expect(() => WithApproval.withApproval(inner, { reason: "publish", approval })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The bound flow has an incompatible output schema: expected Literal, received String"
      })
    )
  })

  it("refuses a blank approval reason with its exact code", () => {
    const inner = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const approval = Flow.make({
      input: Schema.Unknown,
      output: WithApproval.Approved,
      body: () => Node.succeed("approved" as const)
    })

    expect(() => WithApproval.withApproval(inner, { reason: " \t", approval })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Approval reason must not be empty"
      })
    )
    expect(() => WithApproval.withApproval(inner, { reason: " \t", approval })).toThrow(PatternError)
  })
})
