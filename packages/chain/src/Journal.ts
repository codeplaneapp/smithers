/**
 * The append-only journal port — the chain's only state.
 *
 * The in-memory layer is a deletable stand-in for the flows engine journal:
 * the e2e suite asserts journal contents, not this API, so the suite
 * survives the engine swap (`docs/specs/Concepts/Chain Slice.md`).
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Event from "./Event.ts"

/**
 * A journal that cannot be appended to or read.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class JournalError extends Schema.TaggedError<JournalError>()("/chain/JournalError", {
  code: Schema.Literals(["journal_conflict", "journal_unavailable"]).pipe(
    Schema.withConstructorDefault(Effect.succeed("journal_unavailable"))
  ),
  message: Schema.String
}) {}

/**
 * The two operations the chain needs: append one event, read them all.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly append: (event: Event.Event, expectedPosition: number) => Effect.Effect<void, JournalError>
  readonly read: Effect.Effect<ReadonlyArray<Event.Event>, JournalError>
}

/**
 * The journal service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Journal extends Context.Service<Journal, Service>()("/chain/Journal") {}

/**
 * Builds a journal from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => Journal.of(implementation)

const unavailable = (operation: string): JournalError => new JournalError({ message: `${operation} is unavailable` })

/**
 * A journal whose every operation fails as unavailable, with per-operation
 * overrides — the default a test starts from.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    append: Effect.fn("Journal.append")(() => Effect.fail(unavailable("append"))),
    read: Effect.fail(unavailable("read")),
    ...overrides
  })

/**
 * The unavailable journal as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Journal> =>
  Layer.succeed(Journal)(makeNoop(overrides))

/**
 * An in-memory journal over a `Ref`, optionally seeded with prior events —
 * the seed is how tests replay and resume a chain.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerMemory = (initial: ReadonlyArray<Event.Event> = []): Layer.Layer<Journal> =>
  Layer.effect(Journal)(
    Effect.gen(function*() {
      const ref = yield* Ref.make<ReadonlyArray<Event.Event>>(initial)
      return make({
        append: Effect.fn("Journal.append")((event, expectedPosition) =>
          Ref.modify(ref, (events) =>
            events.length === expectedPosition
              ? [undefined, [...events, event]] as const
              : [
                new JournalError({
                  code: "journal_conflict",
                  message: `append expected journal position ${expectedPosition}, found ${events.length}`
                }),
                events
              ] as const).pipe(
              Effect.flatMap((error) => error === undefined ? Effect.void : Effect.fail(error))
            )
        ),
        read: Ref.get(ref)
      })
    })
  )
