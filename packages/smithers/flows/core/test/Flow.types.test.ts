import * as Flow from "@smthrs/core/Flow"
import * as Schema from "effect/Schema"
import { describe, expectTypeOf, it } from "vitest"
import * as Node from "../src/Node.ts"

interface BodyError {
  readonly _tag: "BodyError"
}

describe("Flow types", () => {
  it("exports consumer-nameable make options from the public Flow module", () => {
    const options: Flow.MakeOptions<typeof Schema.String, typeof Schema.Number, BodyError> = {
      input: Schema.String,
      output: Schema.Number,
      body: (input) => Node.succeed(input.length) as Node.Node<number, BodyError>
    }
    const flow = Flow.make(options)

    expectTypeOf(flow).toEqualTypeOf<
      Flow.Flow<typeof Schema.String, typeof Schema.Number, BodyError>
    >()
  })

  it("infers body input from the sibling input schema and returns the declared output", () => {
    const Input = Schema.Struct({
      id: Schema.String,
      count: Schema.Number
    })
    const Output = Schema.Struct({
      accepted: Schema.Boolean
    })
    const flow = Flow.make({
      input: Input,
      output: Output,
      body: (input) => {
        expectTypeOf(input).toEqualTypeOf<typeof Input.Type>()
        return Node.succeed({ accepted: input.count > 0 })
      }
    })

    expectTypeOf(flow({ id: "a", count: 1 })).toEqualTypeOf<Node.Node<typeof Output.Type, never>>()

    // @ts-expect-error count must be a number
    flow({ id: "a", count: "1" })
  })

  it("keeps input schemas invariant in both assignability directions", () => {
    const A = Schema.Struct({ a: Schema.String })
    const AB = Schema.Struct({ a: Schema.String, b: Schema.Number })
    const flowA = Flow.make({
      input: A,
      output: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const flowAB = Flow.make({
      input: AB,
      output: Schema.Void,
      body: () => Node.succeed(undefined)
    })

    // @ts-expect-error Flow input schemas are invariant
    const acceptsAB: Flow.Flow<typeof AB, typeof Schema.Void> = flowA
    // @ts-expect-error Flow input schemas are invariant
    const acceptsA: Flow.Flow<typeof A, typeof Schema.Void> = flowAB

    expectTypeOf(acceptsAB).toEqualTypeOf<Flow.Flow<typeof AB, typeof Schema.Void>>()
    expectTypeOf(acceptsA).toEqualTypeOf<Flow.Flow<typeof A, typeof Schema.Void>>()
  })

  it("uses Flow.Any for heterogeneous concrete flow collections", () => {
    const defaulted = Flow.make({ model: "smart" })
    const text = Flow.make({
      input: Schema.String,
      output: Schema.Number,
      body: (input) => Node.succeed(input.length)
    })
    const toggle = Flow.make({
      input: Schema.Boolean,
      output: Schema.String,
      body: (input) => Node.succeed(String(input))
    })
    const flows: ReadonlyArray<Flow.Any> = [text, toggle]

    expectTypeOf(defaulted).toEqualTypeOf<
      Flow.Flow<typeof Schema.Void, typeof Schema.Unknown, never>
    >()
    expectTypeOf(flows).toMatchTypeOf<ReadonlyArray<Flow.Any>>()
    expectTypeOf<Flow.Input<typeof text>>().toEqualTypeOf<string>()
    expectTypeOf<Flow.Output<typeof toggle>>().toEqualTypeOf<string>()
    expectTypeOf<Flow.Error<typeof text>>().toEqualTypeOf<never>()
  })

  it("keeps schema defaults when only a body is supplied", () => {
    const flow = Flow.make({
      body: (input) => {
        expectTypeOf(input).toEqualTypeOf<void>()
        return Node.succeed("value")
      }
    })

    expectTypeOf(flow).toEqualTypeOf<
      Flow.Flow<typeof Schema.Void, typeof Schema.Unknown, never>
    >()
    expectTypeOf(flow(undefined)).toEqualTypeOf<Node.Node<unknown, never>>()
  })

  it("gives agent the exact make constructor type", () => {
    expectTypeOf(Flow.agent).toEqualTypeOf(Flow.make)
  })

  it("infers the error channel from the body while schemas drive values", () => {
    const flow = Flow.make({
      input: Schema.String,
      output: Schema.Number,
      body: (input) => Node.succeed(input.length) as Node.Node<number, BodyError>
    })

    expectTypeOf(flow).toEqualTypeOf<
      Flow.Flow<typeof Schema.String, typeof Schema.Number, BodyError>
    >()
  })
})
