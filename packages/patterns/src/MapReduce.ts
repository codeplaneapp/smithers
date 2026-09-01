/**
 * Deterministic map-reduce declaration pattern.
 *
 * @see docs/specs/Concepts/Higher Order Flows.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"

/**
 * Empty-input policy for {@link make}.
 *
 * `"fail"` deliberately reports `exhausted`: the caller explicitly chose a
 * spent-bound style failure for an input with no shards.
 *
 * @category models
 * @since 0.1.0
 */
export type OnEmpty = "reduce" | "succeed" | "fail"

/**
 * Configuration for {@link make}.
 *
 * Inputs to the resulting flow are `{ shards }`. Shard keys use their ordinal
 * (`shard-0`, `shard-1`, …), which makes the reduce input independent of
 * worker completion order.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly map: Flow.Any
  readonly reduce: Flow.Any
  readonly concurrency: number
  readonly onEmpty: OnEmpty
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Shard, Mapped, Reduced, E, R, E2, R2> {
  readonly map: (input: {
    readonly shard: Shard
    readonly index: number
    readonly input: I
  }) => Effect.Effect<Mapped, E, R>
  readonly reduce: (input: {
    readonly input: I
    readonly mapped: ReadonlyArray<Mapped>
  }) => Effect.Effect<Reduced, E2, R2>
  readonly concurrency: number
  readonly onEmpty: OnEmpty
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

/**
 * Makes a map-reduce flow.
 *
 * The flow input must be a literal `{ shards }` available while planning.
 * Each shard becomes its own map call.
 * Batches are sequenced to enforce the declared concurrency bound, while
 * members inside a batch fan out with `Node.all`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "MapReduce concurrency must be a positive safe integer"
    })
  }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [options.map, options.reduce],
    body: Node.capture({ concurrency: options.concurrency, onEmpty: options.onEmpty }, (input) => {
      if (
        typeof input !== "object" ||
        input === null ||
        !("shards" in input) ||
        !Array.isArray(input.shards)
      ) {
        throw new PatternError({
          code: "invalid_decorator",
          message: "MapReduce input must contain a shards array"
        })
      }
      const shards = input.shards as ReadonlyArray<unknown>
      if (shards.length === 0) {
        if (options.onEmpty === "fail") {
          throw new PatternError({ code: "exhausted", message: "MapReduce received no shards" })
        }
        return options.onEmpty === "succeed"
          ? Node.succeed([])
          : call(options.reduce, { input, mapped: [] })
      }
      let mapped: Node.Node<ReadonlyArray<unknown>, unknown> = Node.succeed([])
      for (let offset = 0; offset < shards.length; offset += options.concurrency) {
        const members: Record<string, Node.Node<unknown, unknown>> = {}
        const batch = shards.slice(offset, offset + options.concurrency)
        batch.forEach((shard, batchIndex) => {
          const index = offset + batchIndex
          members[`shard-${index}`] = call(options.map, { shard, index, input })
        })
        mapped = Node.andThen(
          mapped,
          Node.capture({ offset }, (previous) =>
            Node.map(
              Node.all(members),
              Node.capture({ offset }, (values) => [
                ...previous,
                ...Object.keys(values).sort((left, right) => Number(left.slice(6)) - Number(right.slice(6))).map((
                  key
                ) => values[key])
              ])
            ))
        )
      }
      return Node.andThen(
        mapped,
        Node.capture(
          { concurrency: options.concurrency, onEmpty: options.onEmpty },
          (values) => call(options.reduce, { input, mapped: values })
        )
      )
    })
  })
}

/**
 * Executes map work with bounded concurrency, preserves shard order, and
 * reduces the real mapped values.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <
  I extends { readonly shards: ReadonlyArray<unknown> },
  Mapped,
  Reduced,
  E,
  R,
  E2,
  R2
>(
  input: I,
  options: RuntimeOptions<I, I["shards"][number], Mapped, Reduced, E, R, E2, R2>
): Effect.Effect<Reduced | ReadonlyArray<Mapped>, E | E2 | PatternError, R | R2> => {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "MapReduce concurrency must be a positive safe integer"
      })
    )
  }
  if (input.shards.length === 0) {
    if (options.onEmpty === "fail") {
      return Effect.fail(new PatternError({ code: "exhausted", message: "MapReduce received no shards" }))
    }
    return options.onEmpty === "succeed"
      ? Effect.succeed([])
      : options.reduce({ input, mapped: [] })
  }
  return Effect.flatMap(
    Effect.forEach(
      input.shards,
      (shard, index) => options.map({ shard, index, input }),
      { concurrency: options.concurrency }
    ),
    (mapped) => options.reduce({ input, mapped })
  )
}
