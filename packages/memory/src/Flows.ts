/**
 * Unsealed memory flow declarations and runtime bindings.
 *
 * The declarations describe the runtime operation but intentionally perform
 * no memory I/O while a graph is being built.
 *
 * @see docs/specs/Concepts/Memory.md
 * @see docs/specs/Concepts/Higher Order Flows.md
 * @since 0.1.0
 */
import * as Effects from "@smthrs/core/Effects"
import * as Flow from "@smthrs/core/Flow"
import * as Pattern from "@smthrs/patterns/Pattern"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { MemoryError } from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Recall from "./Recall.ts"

/**
 * The registry name of the `remember` flow.
 *
 * @category identifiers
 * @since 0.1.0
 * @slop
 */
export const rememberName = "remember"

/**
 * The registry name of the `recall` flow.
 *
 * @category identifiers
 * @since 0.1.0
 * @slop
 */
export const recallName = "recall"

/**
 * The one-line description the model sees for the `remember` flow.
 *
 * @category descriptions
 * @since 0.1.0
 * @slop
 */
export const rememberDescription = "Persist a memory record in a named bank."

/**
 * The one-line description the model sees for the `recall` flow.
 *
 * @category descriptions
 * @since 0.1.0
 * @slop
 */
export const recallDescription = "Recall advisory memory rows from named banks."

/**
 * Input schema for remember.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const RememberInput = Schema.Struct({
  bank: Schema.String,
  key: Schema.String,
  text: Schema.String,
  tags: Schema.optional(Schema.Array(Schema.String))
})

/**
 * Output schema for remember.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const RememberOutput = Schema.Struct({ key: Schema.String })

/**
 * Input schema for recall.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const RecallInput = Recall.Input

/**
 * Output schema for recall.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const RecallOutput = Recall.Output

/**
 * Unsealed effect declaration for durable memory writes.
 *
 * @category effects
 * @since 0.1.0
 * @slop
 */
export const rememberEffects = Effects.make({
  reads: ["memory/**"],
  writes: ["memory/**"],
  mode: "expected",
  onConflict: "serialize",
  tier: "irreversible"
})

/**
 * Unsealed effect declaration for mutable cross-run memory reads.
 *
 * @category effects
 * @since 0.1.0
 * @slop
 */
export const recallEffects = Effects.make({
  reads: ["memory/**"],
  writes: [],
  mode: "expected",
  onConflict: "serialize",
  tier: "irreversible"
})

/**
 * Declaration for a memory write.
 *
 * @category flows
 * @since 0.1.0
 * @slop
 */
export const remember = Flow.make({
  name: rememberName,
  description: rememberDescription,
  input: RememberInput,
  output: RememberOutput,
  effects: rememberEffects
})

/**
 * Declaration for advisory memory recall.
 *
 * @category flows
 * @since 0.1.0
 * @slop
 */
export const recall = Flow.make<typeof RecallInput, typeof RecallOutput, never>({
  name: recallName,
  description: recallDescription,
  input: RecallInput,
  output: RecallOutput,
  effects: recallEffects
})

/**
 * Recall flow-valued slot shared by keyword, FTS, and semantic bindings.
 *
 * @category slots
 * @since 0.1.0
 * @slop
 */
export const recallSlot = Recall.slot

/**
 * Resolves the recall slot to a supplied flow.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const bindRecall = (supplied: Flow.Any): Flow.Any => Pattern.bind(recallSlot, supplied)

/**
 * Runtime binding for the remember declaration.
 *
 * @category handlers
 * @since 0.1.0
 * @slop
 */
export const runRemember = (
  input: RememberInputType
): Effect.Effect<typeof RememberOutput.Type, MemoryError, MemoryStore.MemoryStore> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    yield* store.putFact({
      namespace: Recall.namespaceForBank(input.bank),
      key: input.key,
      value: { content: input.text, tags: input.tags ?? [] },
      provenance: {}
    })
    return { key: input.key }
  })

/**
 * Runtime binding for the selected recall service.
 *
 * @category handlers
 * @since 0.1.0
 * @slop
 */
export const runRecall = (
  input: RecallInputType
): Effect.Effect<RecallOutputType, MemoryError, Recall.Recall> =>
  Effect.flatMap(Recall.Recall, (service) => service.recall(input))

/**
 * Runtime handlers keyed by their public flow declarations.
 *
 * @category handlers
 * @since 0.1.0
 * @slop
 */
export const handlers = {
  remember: runRemember,
  recall: runRecall
} as const

/**
 * What the `remember` flow accepts.
 *
 * @category types
 * @since 0.1.0
 * @slop
 */
export type RememberInputType = typeof RememberInput.Type

/**
 * What the `recall` flow accepts.
 *
 * @category types
 * @since 0.1.0
 * @slop
 */
export type RecallInputType = Recall.Input

/**
 * What the `recall` flow returns.
 *
 * @category types
 * @since 0.1.0
 * @slop
 */
export type RecallOutputType = Recall.Output
