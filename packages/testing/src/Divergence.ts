/**
 * Deterministic journal divergence attribution.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { JournalEntryLike } from "./EngineSubject.ts"
import { FixtureDivergenceError } from "./TestingError.ts"

/**
 * The first attributable difference between two journal entries.
 *
 * @category models
 * @since 0.0.0
 */
export interface Divergence {
  readonly index: number
  readonly field: string
  readonly expected: unknown
  readonly actual: unknown
}

const canonicalValue = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined"
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`
  }
  const record = value as Record<string, unknown>
  return `{${
    Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")
  }}`
}

const entryIndex = (
  expected: JournalEntryLike | undefined,
  actual: JournalEntryLike | undefined,
  fallback: number
): number => expected?.index ?? actual?.index ?? fallback

/**
 * Finds the first differing journal entry, reporting the entry index and the
 * first differing field. Values are compared using canonical object-key order.
 *
 * @category assertions
 * @since 0.0.0
 */
export const firstDivergence = (
  expected: ReadonlyArray<JournalEntryLike>,
  actual: ReadonlyArray<JournalEntryLike>
): Option.Option<Divergence> => {
  const length = Math.max(expected.length, actual.length)
  for (let position = 0; position < length; position += 1) {
    const expectedEntry = expected[position]
    const actualEntry = actual[position]
    if (expectedEntry === undefined || actualEntry === undefined) {
      return Option.some({
        index: entryIndex(expectedEntry, actualEntry, position),
        field: "entry",
        expected: expectedEntry,
        actual: actualEntry
      })
    }
    for (const field of ["stepKey", "kind", "outcome"] as const) {
      if (expectedEntry[field] !== actualEntry[field]) {
        return Option.some({
          index: entryIndex(expectedEntry, actualEntry, position),
          field,
          expected: expectedEntry[field],
          actual: actualEntry[field]
        })
      }
    }
    if (canonicalValue(expectedEntry.value) !== canonicalValue(actualEntry.value)) {
      return Option.some({
        index: entryIndex(expectedEntry, actualEntry, position),
        field: "value",
        expected: expectedEntry.value,
        actual: actualEntry.value
      })
    }
  }
  return Option.none()
}

/**
 * Fails with the first journal divergence. CI callers must report this failure
 * rather than silently re-recording the fixture.
 *
 * @category assertions
 * @since 0.0.0
 */
export const assertNoDivergence = (
  expected: ReadonlyArray<JournalEntryLike>,
  actual: ReadonlyArray<JournalEntryLike>
): Effect.Effect<void, FixtureDivergenceError> => {
  const divergence = firstDivergence(expected, actual)
  return Option.match(divergence, {
    onNone: () => Effect.void,
    onSome: (difference) => Effect.fail(new FixtureDivergenceError(difference))
  })
}
