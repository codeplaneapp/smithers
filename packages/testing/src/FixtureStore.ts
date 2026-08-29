/**
 * Where a cached model reads and records its fixture.
 *
 * The store is the only part of the record-and-replay loop that touches a
 * host: `layerFile` is Node-only, `layerMemory` runs anywhere.
 *
 * @since 0.0.0
 */
import { Context, Effect, Layer, Option, Ref, SynchronizedRef } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { decode, type Fixture, type RecordedCall } from "./Fixture.ts"

/**
 * Loads and records a recorded-model fixture.
 *
 * Neither method has an error channel. A fixture that cannot be read or decoded
 * is a broken test setup, not an outcome the code under test can handle, so it
 * is a defect; a fixture that does not exist yet is `None`, which is what a
 * first recording run sees.
 *
 * @category services
 * @since 0.0.0
 */
export interface FixtureStore {
  readonly load: () => Effect.Effect<Option.Option<Fixture>>
  readonly append: (call: RecordedCall) => Effect.Effect<void>
}

/**
 * The {@link FixtureStore} service tag.
 *
 * @category services
 * @since 0.0.0
 */
export const FixtureStore: Context.Service<FixtureStore, FixtureStore> = Context.Service(
  "flows/testing/FixtureStore"
)

/**
 * Builds a {@link FixtureStore} from an implementation of its two methods.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (implementation: FixtureStore): FixtureStore => FixtureStore.of(implementation)

const appended = (current: Option.Option<Fixture>, call: RecordedCall): Fixture => ({
  calls: [...Option.match(current, { onNone: () => [], onSome: (fixture) => fixture.calls }), call]
})

/**
 * Builds a store that keeps the fixture in memory.
 *
 * `load` reports `None` until the first call is recorded, so an empty memory
 * store behaves exactly like a file that does not exist yet.
 *
 * @category constructors
 * @since 0.0.0
 */
export const makeMemory = (initial?: Fixture): Effect.Effect<FixtureStore> =>
  Effect.gen(function*() {
    const state = yield* Ref.make(Option.fromUndefinedOr(initial))
    return make({
      load: () => Ref.get(state),
      append: (call) => Ref.update(state, (current) => Option.some(appended(current, call)))
    })
  })

/**
 * Provides {@link makeMemory}.
 *
 * @category layers
 * @since 0.0.0
 */
export const layerMemory = (initial?: Fixture): Layer.Layer<FixtureStore> =>
  Layer.effect(FixtureStore)(makeMemory(initial))

const readFixture = (path: string): Effect.Effect<Option.Option<Fixture>> =>
  Effect.suspend(() =>
    existsSync(path)
      ? decode(JSON.parse(readFileSync(path, "utf8"))).pipe(Effect.map(Option.some), Effect.orDie)
      : Effect.succeed(Option.none())
  )

const writeFixture = (path: string, fixture: Fixture): Effect.Effect<void> =>
  Effect.sync(() => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(fixture, undefined, 2)}\n`)
  })

/**
 * Builds a store over a JSON file. Node only.
 *
 * The file is read once, when the store is built, and every `append` rewrites
 * it, so a recording run leaves a committable fixture behind even if a later
 * test in the same run fails. Writes are serialized: concurrent model calls
 * would otherwise each rewrite the file from its own snapshot and drop the
 * calls recorded in between.
 *
 * @category constructors
 * @since 0.0.0
 */
export const makeFile = (path: string): Effect.Effect<FixtureStore> =>
  Effect.gen(function*() {
    const state = yield* SynchronizedRef.make(yield* readFixture(path))
    return make({
      load: () => SynchronizedRef.get(state),
      append: (call) =>
        SynchronizedRef.updateEffect(state, (current) => {
          const next = appended(current, call)
          return writeFixture(path, next).pipe(Effect.as(Option.some(next)))
        })
    })
  })

/**
 * Provides {@link makeFile}.
 *
 * @category layers
 * @since 0.0.0
 */
export const layerFile = (path: string): Layer.Layer<FixtureStore> => Layer.effect(FixtureStore)(makeFile(path))
