import { Schema } from "effect"
import { expectTypeOf, test } from "vitest"
import * as Flow from "../src/Flow.ts"
import * as Node from "../src/Node.ts"

interface FirstError {
  readonly _tag: "FirstError"
}

interface SecondError {
  readonly _tag: "SecondError"
}

test("all preserves exact readonly keys and success members", () => {
  const a: Node.Node<string> = Node.succeed("value")
  const b: Node.Node<number> = Node.succeed(1)
  const result = Node.all({ a, b })

  expectTypeOf(result).toEqualTypeOf<
    Node.Node<{ readonly a: string; readonly b: number }, never>
  >()
})

test("andThen unions both error channels", () => {
  const first = Node.succeed("value") as Node.Node<string, FirstError>
  const second = Node.succeed(1) as Node.Node<number, SecondError>
  const dataFirst = Node.andThen(first, () => second)
  const dataLast = first.pipe(Node.andThen(() => second))
  const staticNode = Node.andThen(first, second)

  expectTypeOf(dataFirst).toEqualTypeOf<Node.Node<number, FirstError | SecondError>>()
  expectTypeOf(dataLast).toEqualTypeOf<Node.Node<number, FirstError | SecondError>>()
  expectTypeOf(staticNode).toEqualTypeOf<Node.Node<number, FirstError | SecondError>>()
})

test("map preserves the error channel", () => {
  const source = Node.succeed("value") as Node.Node<string, FirstError>
  const dataFirst = Node.map(source, (value) => value.length)
  const dataLast = source.pipe(Node.map((value) => value.length))

  expectTypeOf(dataFirst).toEqualTypeOf<Node.Node<number, FirstError>>()
  expectTypeOf(dataLast).toEqualTypeOf<Node.Node<number, FirstError>>()
})

test("dynamic infers schema output and accepts an explicit output type", () => {
  const inferred = Node.dynamic({ output: Schema.String })
  const explicit = Node.dynamic<string>({ model: "test-model" })

  expectTypeOf(inferred).toEqualTypeOf<Node.Node<string>>()
  expectTypeOf(explicit).toEqualTypeOf<Node.Node<string>>()
})

test("dynamic accepts only named or flow-valued collaborators", () => {
  const flow = Flow.make({ body: () => Node.succeed("done") })

  Node.dynamic({ flows: ["name"] })
  Node.dynamic({ flows: [flow] })
  // @ts-expect-error Dynamic collaborators must be names or Flow values.
  Node.dynamic({ flows: [42] })
})

test("covariance admits never-valued nodes in heterogeneous records", () => {
  const impossible = Node.succeed(undefined as never)
  const value = Node.succeed("value")
  const members: Readonly<Record<string, Node.Any>> = { impossible, value }
  const result = Node.all({ impossible, value })

  expectTypeOf(members).toExtend<Readonly<Record<string, Node.Any>>>()
  expectTypeOf<Node.Node<never>>().toExtend<Node.Node<string>>()
  expectTypeOf(result).toEqualTypeOf<
    Node.Node<{ readonly impossible: never; readonly value: string }, never>
  >()
})
