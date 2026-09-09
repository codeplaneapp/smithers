import { Flow, Node } from "@smthrs/core"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as internal from "../src/internal/node.ts"
import * as TestRuntime from "../src/TestRuntime.ts"

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const failure = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error("expected failure")
  return result.failure
}

describe("TestRuntime", () => {
  it("evaluates constants, static sequencing, maps, and prototype-shaped joins", () => {
    const joined = Node.all({
      ["__proto__"]: Node.succeed(1),
      constructor: Node.succeed(2),
      value: Node.succeed(3)
    })
    const mapped = Node.map(joined, (values) => Object.values(values).reduce((sum, value) => sum + value, 0))
    const program = Node.andThen(mapped, Node.succeed("done"))

    expect(success(TestRuntime.evaluate(mapped))).toBe(6)
    expect(success(TestRuntime.evaluate(Node.andThen(mapped, (value) => Node.succeed(value * 2))))).toBe(12)
    expect(success(TestRuntime.evaluate(program))).toBe("done")
    const values = success(TestRuntime.evaluate(joined))
    expect(values).toEqual({ ["__proto__"]: 1, constructor: 2, value: 3 })
    expect(Object.hasOwn(values, "__proto__")).toBe(true)
    expect(values["__proto__"]).toBe(1)
  })

  it("evaluates dynamic nodes and flow calls through one explicit resolver", () => {
    const child = Flow.make({
      name: "child",
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const requests: Array<TestRuntime.Request> = []
    const resolver: TestRuntime.Resolver<string> = (request) => {
      requests.push(request)
      return request._tag === "Dynamic"
        ? Result.succeed("dynamic")
        : Result.succeed(`${request.input}:flow`)
    }
    const program = Node.all({
      dynamic: Node.dynamic({ model: "seat", prompt: "prompt", output: Schema.String }),
      flow: child("input")
    })

    expect(success(TestRuntime.evaluate(program, resolver))).toEqual({ dynamic: "dynamic", flow: "input:flow" })
    expect(requests.map((request) => request._tag)).toEqual(["Dynamic", "FlowCall"])
    expect(requests[0]).toMatchObject({ model: "seat", prompt: "prompt" })
    expect(requests[1]).toMatchObject({ flow: child, input: "input" })
  })

  it("optionally enters composed flow bodies and resolves only bodyless leaves", () => {
    const inner = Flow.make({
      name: "inner",
      input: Schema.String,
      output: Schema.String,
      body: (input) =>
        Node.andThen(
          Node.map(Node.succeed(input), (value) => `${value}:mapped`),
          (value) => Node.succeed(`${value}:inlined`)
        )
    })
    const leaf = Flow.make({ name: "leaf", input: Schema.String, output: Schema.String })
    const composed = Node.all({
      inner: inner("a"),
      leaf: internal.makeNode(internal.flowCall(
        leaf,
        { _tag: "FlowReference", name: "leaf" },
        "b",
        Node.succeed(undefined).ast.annotations
      )),
      opaque: internal.makeNode(internal.flowCall(
        { opaque: true },
        { _tag: "FlowReference", name: "opaque" },
        "c",
        Node.succeed(undefined).ast.annotations
      ))
    })

    expect(
      success(
        TestRuntime.evaluateInline(
          composed,
          (request) =>
            request._tag === "FlowCall" ? Result.succeed(`${request.input}:resolved`) : Result.fail("unexpected")
        )
      )
    ).toEqual({ inner: "a:mapped:inlined", leaf: "b:resolved", opaque: "c:resolved" })
  })

  it("refuses malformed and throwing inlined flow bodies", () => {
    const defect = new Error("body exploded")
    const malformed = Flow.make({
      input: Schema.Unknown,
      output: Schema.Unknown,
      body: (() => "not a node") as never
    })
    const throwing = Flow.make({
      input: Schema.Unknown,
      output: Schema.Unknown,
      body: (() => {
        throw defect
      }) as never
    })

    expect(failure(TestRuntime.evaluateInline(malformed(null)))).toMatchObject({ code: "invalid_continuation" })
    expect(failure(TestRuntime.evaluateInline(throwing(null)))).toMatchObject({ code: "callback_threw", cause: defect })
  })

  it("propagates failures and evaluates matching recovery arms", () => {
    const typed = Schema.Struct({ _tag: Schema.Literal("Typed"), detail: Schema.String })
    const error = { _tag: "Typed", detail: "failed" } as const
    const recovered = Node.catch(Node.fail(error), {
      error: typed,
      onFailure: (failure) => Node.succeed(failure.detail)
    })
    const unhandled = Node.catch(Node.fail("plain"), {
      error: typed,
      onFailure: () => Node.succeed("unreachable")
    })

    expect(success(TestRuntime.evaluate(recovered))).toBe("failed")
    expect(failure(TestRuntime.evaluate(unhandled))).toBe("plain")
    expect(failure(TestRuntime.evaluate(Node.all({ ok: Node.succeed(1), bad: Node.fail("bad") })))).toBe("bad")
    expect(success(TestRuntime.evaluate(Node.catch(Node.fail("bad"), {
      onFailure: (value) => Node.succeed(`handled:${value}`)
    })))).toBe("handled:bad")
    expect(success(TestRuntime.evaluate(Node.catch(Node.succeed("good"), {
      onFailure: () => Node.succeed("unreachable")
    })))).toBe("good")
    expect(failure(TestRuntime.evaluate(Node.andThen(Node.fail("first failed"), Node.succeed("next")))))
      .toBe("first failed")
  })

  it("turns resolver and callback defects into evaluator failures", () => {
    const resolverDefect = new Error("resolver exploded")
    const callbackDefect = new Error("callback exploded")
    const resolverFailure = failure(TestRuntime.evaluate(Node.dynamic({}), () => {
      throw resolverDefect
    }))
    const callbackFailure = failure(TestRuntime.evaluate(Node.map(Node.succeed(1), () => {
      throw callbackDefect
    })))
    const andThenFailure = failure(TestRuntime.evaluate(Node.andThen(Node.succeed(1), () => {
      throw callbackDefect
    })))
    const catchFailure = failure(TestRuntime.evaluate(Node.catch(Node.fail("bad"), {
      onFailure: () => {
        throw callbackDefect
      }
    })))

    expect(resolverFailure).toMatchObject({ code: "resolver_threw", cause: resolverDefect })
    expect(callbackFailure).toMatchObject({ code: "callback_threw", cause: callbackDefect })
    expect(andThenFailure).toMatchObject({ code: "callback_threw", cause: callbackDefect })
    expect(catchFailure).toMatchObject({ code: "callback_threw", cause: callbackDefect })
  })

  it.each(["callback_threw", "unresolved_node", "missing_operation", "resolver_threw"] as const)(
    "keeps %s out of recovery arms",
    (code) => {
      const cause = new Error("broken declaration")
      const mapped = Node.map(Node.succeed(1), () => {
        throw cause
      })
      const lostMap = internal.makeNode({ ...Node.map(Node.succeed(1), (value) => value).ast })
      const cases: ReadonlyArray<{
        node: Node.Node<unknown, unknown>
        resolver?: TestRuntime.Resolver
        code: TestRuntime.EvaluationErrorCode
        cause?: unknown
      }> = [
        { node: mapped, code: "callback_threw", cause },
        { node: Node.dynamic({}), code: "unresolved_node" },
        { node: lostMap, code: "missing_operation" },
        {
          node: Node.dynamic({}),
          resolver: () => {
            throw cause
          },
          code: "resolver_threw",
          cause
        }
      ]
      const testCase = cases.find((testCase) => testCase.code === code)!
      for (const evaluate of [TestRuntime.evaluate, TestRuntime.evaluateInline]) {
        let calls = 0
        const caught = Node.catch(
          Node.catch(testCase.node, {
            error: Schema.Unknown,
            onFailure: () => {
              calls++
              return Node.succeed("looks good")
            }
          }),
          {
            onFailure: () => {
              calls++
              return Node.succeed("fallback")
            }
          }
        )
        const error = failure(evaluate(caught, testCase.resolver))
        expect(error).toBeInstanceOf(TestRuntime.EvaluationError)
        expect(error).toMatchObject({ code: testCase.code, cause: testCase.cause })
        expect(calls).toBe(0)
      }
    }
  )

  it("recovers typed node and resolver failures even when their value is an EvaluationError", () => {
    const error = new TestRuntime.EvaluationError("callback_threw", "typed failure")
    const recover = (node: Node.Node<unknown, unknown>) =>
      Node.catch(node, {
        onFailure: (value) => Node.succeed(value)
      })

    expect(success(TestRuntime.evaluate(recover(Node.fail(error))))).toBe(error)
    expect(success(TestRuntime.evaluate(recover(Node.dynamic({})), () => Result.fail(error)))).toBe(error)
  })

  it.each([TestRuntime.evaluate, TestRuntime.evaluateInline])(
    "skips downstream callbacks after failure (%#)",
    (evaluate) => {
      const calls: Array<string> = []
      const program = Node.andThen(
        Node.map(Node.fail("failed"), () => {
          calls.push("map")
          return 1
        }),
        (value) => {
          calls.push("andThen")
          return Node.succeed(value + 1)
        }
      )

      expect(failure(evaluate(program))).toBe("failed")
      expect(calls).toEqual([])
    }
  )

  it("refuses unresolved leaves and ASTs that lost their in-memory side tables", () => {
    expect(failure(TestRuntime.evaluate(Node.dynamic({})))).toMatchObject({ code: "unresolved_node" })

    const flowAst = Node.dynamic({}).ast as internal.Dynamic
    const lostFlow = internal.makeNode({
      _tag: "FlowCall",
      target: "target",
      input: "input",
      annotations: flowAst.annotations
    })
    expect(failure(TestRuntime.evaluate(lostFlow))).toMatchObject({ code: "missing_flow" })

    const lostMap = internal.makeNode(internal.map(
      Node.succeed(1).ast,
      (value) => value,
      (value: unknown) => value,
      flowAst.annotations
    ))
    const copiedMap = internal.makeNode({ ...lostMap.ast })
    expect(failure(TestRuntime.evaluate(copiedMap))).toMatchObject({ code: "missing_operation" })

    const lostAndThen = internal.makeNode(internal.andThen(
      Node.succeed(1).ast,
      () => Node.succeed(2),
      () => Node.succeed(2),
      flowAst.annotations
    ))
    const lostCatch = internal.makeNode(internal.catch_(
      Node.fail("bad").ast,
      () => Node.succeed("handled"),
      () => Node.succeed("handled"),
      undefined,
      flowAst.annotations
    ))
    expect(failure(TestRuntime.evaluate(internal.makeNode({ ...lostAndThen.ast })))).toMatchObject({
      code: "missing_operation"
    })
    expect(failure(TestRuntime.evaluate(internal.makeNode({ ...lostCatch.ast })))).toMatchObject({
      code: "missing_operation"
    })
  })

  it("refuses malformed continuations, schemas, and excessive nesting", () => {
    const annotations = Node.succeed(undefined).ast.annotations
    const malformedAndThen = internal.makeNode(internal.andThen(
      Node.succeed(1).ast,
      () => "not a node",
      () => "not a node",
      annotations
    ))
    const malformedCatch = internal.makeNode(internal.catch_(
      Node.fail("bad").ast,
      () => "not a node",
      () => "not a node",
      undefined,
      annotations
    ))
    const invalidSchema = internal.makeNode(internal.catch_(
      Node.fail("bad").ast,
      () => Node.succeed("handled"),
      () => Node.succeed("handled"),
      "not a schema",
      annotations
    ))

    expect(failure(TestRuntime.evaluate(malformedAndThen))).toMatchObject({ code: "invalid_continuation" })
    expect(failure(TestRuntime.evaluate(malformedCatch))).toMatchObject({ code: "invalid_continuation" })
    expect(failure(TestRuntime.evaluate(invalidSchema))).toMatchObject({ code: "invalid_schema" })

    let nested: Node.Node<number> = Node.succeed(1)
    for (let index = 0; index < 1_024; index++) nested = Node.map(nested, (value) => value)
    expect(success(TestRuntime.evaluate(nested))).toBe(1)
    nested = Node.map(nested, (value) => value)
    expect(failure(TestRuntime.evaluate(nested))).toMatchObject({ code: "depth_exceeded" })
  })

  it("preserves typed resolver failures", () => {
    const result = TestRuntime.evaluate(Node.dynamic({}), () => Result.fail("model unavailable"))
    expect(failure(result)).toBe("model unavailable")
    expect(Exit.isExit(result)).toBe(false)
  })
})
