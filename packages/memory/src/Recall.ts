/**
 * The replaceable memory-recall seam.
 *
 * Recall is both a flow-valued injection slot and an Effect runtime service.
 *
 * @see docs/specs/Concepts/Memory.md
 * @see docs/specs/Concepts/Injection And Decoration.md
 *
 * @since 0.1.0
 */
import * as Pattern from "@smthrs/patterns/Pattern"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as MemoryError from "./MemoryError.ts"
import * as Namespace from "./Namespace.ts"

/**
 * A boolean tag predicate accepted by every recall implementation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TagGroup = Namespace.TagGroup

/**
 * Input to the recall slot.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Input = Schema.Struct({
  banks: Schema.Array(Schema.String),
  query: Schema.String,
  tagGroups: Schema.optional(Schema.Array(Namespace.TagGroup)),
  maxTokens: Schema.optional(Schema.Int),
  budget: Schema.optional(Schema.Literals(["low", "mid", "high"]))
})

/**
 * Input to the recall slot.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Input = typeof Input.Type

/**
 * One recalled memory row.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Result = Schema.Struct({
  bank: Schema.String,
  key: Schema.String,
  text: Schema.String,
  score: Schema.Number,
  updatedAtMs: Schema.optional(Schema.Number)
})

/**
 * One recalled memory row.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Result = typeof Result.Type

/**
 * Output of the recall slot.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Output = Schema.Array(Result)

/**
 * Output of the recall slot.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Output = typeof Output.Type

/**
 * Flow-valued recall injection slot.
 *
 * @category slots
 * @since 0.1.0
 * @slop
 */
export const slot = Pattern.slot({ input: Input, output: Output })

/**
 * Runtime recall implementation.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly recall: (input: Input) => Effect.Effect<Output, MemoryError.MemoryError>
}

/**
 * Context tag for the replaceable recall implementation.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Recall extends Context.Service<Recall, Service>()("flows/memory/Recall") {}

const encoder = new TextEncoder()

const serializedByteLength = (results: ReadonlyArray<Result>): number =>
  encoder.encode(JSON.stringify(results)).byteLength

/**
 * Applies Smithers' conservative UTF-8 byte cap: complete rows are selected
 * greedily, then only the first overflowing row is truncated by binary search.
 * `maxTokens` is treated as a byte ceiling because UTF-8 bytes conservatively
 * bound token count without selecting a model-specific tokenizer.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const capRecallResults = (results: ReadonlyArray<Result>, maxTokens = 2048): Array<Result> => {
  const normalized = results.filter((result) => result.text.length > 0)
  const byteBudget = Math.max(0, Math.floor(maxTokens))
  const selected: Array<Result> = []
  for (const result of normalized) {
    if (serializedByteLength([...selected, result]) <= byteBudget) {
      selected.push(result)
      continue
    }
    const characters = [...result.text]
    let low = 0
    let high = characters.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = { ...result, text: characters.slice(0, middle).join("") }
      if (serializedByteLength([...selected, candidate]) <= byteBudget) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    if (low > 0) {
      selected.push({ ...result, text: characters.slice(0, low).join("") })
    }
    break
  }
  return selected
}

/**
 * Constructs a recall service.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => Recall.of(implementation)

/**
 * Provides a recall service.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (implementation: Service): Layer.Layer<Recall> => Layer.succeed(Recall)(make(implementation))

/**
 * Constructs a recall service that returns no rows.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (): Service => Recall.of({ recall: () => Effect.succeed([]) })

/**
 * Provides the empty recall implementation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop: Layer.Layer<Recall> = Layer.succeed(Recall)(makeNoop())

/**
 * Namespace type marker retained for consumers that want to associate a
 * recall bank with a structured namespace without coupling the slot to it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type NamespaceValue = Namespace.Namespace

/**
 * Maps a public bank name to the structured namespace used by MemoryStore.
 * Prefixes preserve explicit lifetimes; an unprefixed bank is flow-local.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const namespaceForBank = (bank: string): Namespace.Namespace => {
  for (const kind of ["flow", "agent", "user", "global"] as const) {
    const prefix = `${kind}-`
    if (bank.startsWith(prefix) && bank.length > prefix.length) {
      return { kind, id: bank.slice(prefix.length) }
    }
  }
  return { kind: "flow", id: bank }
}
