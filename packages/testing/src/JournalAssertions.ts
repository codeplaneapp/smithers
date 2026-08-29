/**
 * Effect-valued assertions over a flow journal.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect"
import type { JournalEntryLike } from "./EngineSubject.ts"
import { ExactlyOnceUnsupportedError, type JournalAssertionCode, JournalAssertionError } from "./TestingError.ts"

/**
 * A terminal outcome recorded by an engine journal.
 *
 * @category models
 * @since 0.0.0
 */
export type TerminalStatus = JournalEntryLike["outcome"]

/**
 * Fluent effect assertions for one journal.
 *
 * @category models
 * @since 0.0.0
 */
export interface JournalExpectations {
  readonly executed: (stepKey: string) => Effect.Effect<void, JournalAssertionError>
  readonly executedInOrder: (keys: ReadonlyArray<string>) => Effect.Effect<void, JournalAssertionError>
  readonly terminal: (status: TerminalStatus) => Effect.Effect<void, JournalAssertionError>
  readonly effect: (key: string) => EffectExpectations
  readonly prefix: (untilIndex: number) => ReadonlyArray<JournalEntryLike>
}

/**
 * Fluent effect assertions for one effect key in a journal.
 *
 * @category models
 * @since 0.0.0
 */
export interface EffectExpectations {
  readonly atLeastOnce: () => Effect.Effect<void, JournalAssertionError>
  readonly journaledAtMostOnce: () => Effect.Effect<void, JournalAssertionError>
  readonly idempotencyKey: (key: string) => Effect.Effect<void, JournalAssertionError>
  /**
   * Always fails: an engine can prove at-least-once delivery and at-most-once
   * journaling, but it cannot prove exactly-once external effect execution.
   * Keeping this method deliberately failing prevents test vocabulary from
   * claiming a guarantee the engine does not provide.
   *
   * @since 0.0.0
   * @category assertions
   */
  readonly exactlyOnce: () => Effect.Effect<void, ExactlyOnceUnsupportedError>
}

const failure = (
  code: JournalAssertionCode,
  message: string,
  expected?: unknown,
  actual?: unknown
): Effect.Effect<never, JournalAssertionError> =>
  Effect.fail(
    new JournalAssertionError({
      code,
      message,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual })
    })
  )

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const idempotencyKeyOf = (entry: JournalEntryLike): unknown =>
  isRecord(entry.value) ? entry.value.idempotencyKey : undefined

/**
 * Builds fluent, Effect-valued assertions over journal entries.
 *
 * @category assertions
 * @since 0.0.0
 */
export const expectJournal = (entries: ReadonlyArray<JournalEntryLike>): JournalExpectations => {
  const effect = (key: string): EffectExpectations => {
    const matching = entries.filter((entry) => entry.stepKey === key)
    return {
      atLeastOnce: () =>
        matching.length > 0
          ? Effect.void
          : failure(
            "effect_not_executed",
            `expected effect ${JSON.stringify(key)} to execute at least once`,
            key,
            []
          ),
      journaledAtMostOnce: () =>
        matching.length <= 1
          ? Effect.void
          : failure(
            "effect_journaled_more_than_once",
            `expected effect ${JSON.stringify(key)} to be journaled at most once; found ${matching.length}`,
            1,
            matching.length
          ),
      idempotencyKey: (idempotencyKey) => {
        const mismatch = matching.find((entry) => idempotencyKeyOf(entry) !== idempotencyKey)
        return matching.length === 0
          ? failure(
            "missing_idempotency_key",
            `expected effect ${JSON.stringify(key)} to have idempotency key ${JSON.stringify(idempotencyKey)}`,
            idempotencyKey,
            undefined
          )
          : mismatch === undefined
          ? Effect.void
          : failure(
            "idempotency_key_mismatch",
            `expected effect ${JSON.stringify(key)} to have idempotency key ${JSON.stringify(idempotencyKey)}`,
            idempotencyKey,
            idempotencyKeyOf(mismatch)
          )
      },
      exactlyOnce: () =>
        Effect.fail(
          new ExactlyOnceUnsupportedError({
            message: `exactly-once is unsupported for effect ${JSON.stringify(key)}`
          })
        )
    }
  }

  return {
    executed: (stepKey) =>
      entries.some((entry) => entry.stepKey === stepKey)
        ? Effect.void
        : failure("step_not_executed", `expected step ${JSON.stringify(stepKey)} to execute`, stepKey, []),
    executedInOrder: (keys) => {
      let cursor = 0
      for (const entry of entries) {
        if (entry.stepKey === keys[cursor]) {
          cursor += 1
        }
      }
      return cursor === keys.length
        ? Effect.void
        : failure(
          "execution_order_mismatch",
          `expected steps to execute in order: ${keys.map((key) => JSON.stringify(key)).join(", ")}`,
          keys,
          entries.map((entry) => entry.stepKey)
        )
    },
    terminal: (status) => {
      const entry = entries.at(-1)
      return entry?.outcome === status
        ? Effect.void
        : failure(
          "terminal_status_mismatch",
          `expected terminal status ${JSON.stringify(status)}, received ${JSON.stringify(entry?.outcome)}`,
          status,
          entry?.outcome
        )
    },
    effect,
    prefix: (untilIndex) => entries.filter((entry) => entry.index <= untilIndex)
  }
}
