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
import { maximumDepth, snapshot } from "./internal/Structural.ts"

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

const plainRecord = (value: unknown): value is Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Freezes the arrays and plain records `snapshot` just built, and nothing else.
 *
 * `snapshot` recreates exactly the array and plain-record spine and passes any
 * other value through by reference, so this walk freezes only values the store
 * owns: freezing a passed-through class instance would freeze the caller's. It
 * stops at `snapshot`'s own depth boundary for the same reason, and because a
 * walk without one is the unbounded recursion the encoder was just given a cap
 * to avoid.
 */
const owned = <A>(value: A, seen: Set<object>, depth: number): A => {
  if (depth >= maximumDepth) return value
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    for (const item of value) owned(item, seen, depth + 1)
    return Object.freeze(value)
  }
  if (!plainRecord(value)) return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) owned(value[key], seen, depth + 1)
  return Object.freeze(value)
}

/**
 * The store's own immutable copy of a recorded call.
 *
 * Both boundaries used to alias the caller's values: `append` copied the calls
 * array and nothing inside it, and `load` handed those same references back.
 * A harness that reused one event object across turns, or that rewrote a tool
 * schema after the call was recorded, retroactively rewrote what the fixture
 * had already recorded, and `makeFile` then wrote the rewritten value to disk
 * on the next flush.
 *
 * The copy is frozen rather than re-copied on every `load`, because
 * `Fixture.index` memoizes its digest index on fixture identity: handing back
 * a fresh copy per load would rebuild that index on every model call.
 */
const recorded = <A>(value: A): A => owned(snapshot(value), new Set<object>(), 0)

const appended = (current: Option.Option<Fixture>, call: RecordedCall): Fixture =>
  Object.freeze({
    calls: Object.freeze([
      ...Option.match(current, { onNone: () => [], onSome: (fixture) => fixture.calls }),
      recorded(call)
    ])
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
    const state = yield* Ref.make(Option.map(Option.fromUndefinedOr(initial), recorded))
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
      ? decode(JSON.parse(readFileSync(path, "utf8"))).pipe(
        Effect.map((fixture) => Option.some(recorded(fixture))),
        Effect.orDie
      )
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
