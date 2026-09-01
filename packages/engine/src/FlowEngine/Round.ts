/**
 * Round identity inside a trampoline lineage.
 *
 * `docs/specs/Concepts/Trampoline Loops.md` makes every round its own
 * execution, chained under one lineage: the lineage is "the run" a UI, a
 * budget, and time travel attach to, and a round is one fully planned DAG
 * inside it. That leaves exactly one thing to mint, and this module mints it —
 * the next round's execution id.
 *
 * It is DERIVED rather than allocated, from `(lineageId, roundOrdinal)`,
 * through the same injected SHA-256 the rest of the tree derives identity with.
 * That is what makes the handoff at-most-once: a process that dies between
 * settling round N and opening round N+1 re-derives the same id when it comes
 * back, so the re-drive lands on the round that already exists instead of
 * starting a second copy of it. Round 0 is the exception by construction — its
 * id is the one the caller executed, and it is also the lineage id every later
 * round derives from.
 *
 * @since 0.1.0
 */
import { Sha256 } from "@smthrs/crypto"
import { Flow } from "@smthrs/flow"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Where one execution sits in its lineage: which lineage it belongs to, and
 * which round of it this is, counted from zero.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Round {
  readonly lineageId: string
  readonly ordinal: number
}

/**
 * A malformed trampoline identity or resource bound.
 *
 * @category errors
 * @since 1.0.0
 */
export class InvalidRound extends Schema.TaggedError<InvalidRound>()(
  "@smthrs/engine/InvalidRound",
  {
    code: Schema.Literal("invalid_round").pipe(
      Schema.withConstructorDefault(Effect.succeed("invalid_round"))
    ),
    message: Schema.String
  }
) {}

const invalid = (message: string): InvalidRound => new InvalidRound({ message })

const wellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (next < 0xdc00 || next > 0xdfff) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

const validLineage = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && wellFormed(value)

const validOrdinal = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const validate = (round: Round): InvalidRound | undefined => {
  try {
    if (!validLineage(round.lineageId)) return invalid("Round lineageId must be non-empty well-formed text")
    if (!validOrdinal(round.ordinal)) return invalid("Round ordinal must be a non-negative safe integer")
    return undefined
  } catch {
    return invalid("Round must expose inert lineageId and ordinal data")
  }
}

/**
 * The round a lineage starts at: ordinal zero, with the caller's execution id
 * as the lineage id every later round derives from.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const initial = (executionId: string): Round => {
  if (!validLineage(executionId)) throw invalid("Round lineageId must be non-empty well-formed text")
  return { lineageId: executionId, ordinal: 0 }
}

/**
 * The execution id a round runs under.
 *
 * Derived from the lineage and the ordinal alone, so it is the same id in
 * every process and after every restart.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const executionId = (round: Round): Effect.Effect<string, InvalidRound, Crypto.Crypto> =>
  Effect.suspend(() => {
    const refusal = validate(round)
    return refusal === undefined
      ? Schema.decodeUnknownEffect(Sha256)(
        JSON.stringify(["flow-round/v2", round.lineageId, round.ordinal])
      ).pipe(Effect.orDie)
      : Effect.fail(refusal)
  })

/**
 * The round that follows this one, and the execution id it runs under.
 *
 * Fails with {@link module:Flow.MaxRoundsExceeded} when the lineage has spent
 * its declared budget. An absent budget is unbounded, which is the right
 * default for a lineage whose exit condition is its own branch.
 *
 * DECIDED (2026-08-11, pending review): the budget counts ROUNDS, not handoffs,
 * so a lineage bounded at `n` may open ordinals `0` through `n - 1` and the
 * request for ordinal `n` is the one that is refused. Counting rounds is what a
 * reader of `maxRounds: 100` expects, and it makes `maxRounds: 1` mean "no
 * handoff at all" rather than "one handoff".
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const next = (round: Round, options: {
  readonly flowName: string
  readonly maxRounds: number | undefined
}): Effect.Effect<
  { readonly round: Round; readonly executionId: string },
  Flow.MaxRoundsExceeded | InvalidRound,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const refusal = validate(round)
    if (refusal !== undefined) return yield* Effect.fail(refusal)
    const budget = options.maxRounds
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1)) {
      return yield* Effect.fail(invalid("Round maxRounds must be a positive safe integer when supplied"))
    }
    if (round.ordinal === Number.MAX_SAFE_INTEGER) {
      return yield* Effect.fail(invalid("Round ordinal cannot be advanced beyond Number.MAX_SAFE_INTEGER"))
    }
    const advanced: Round = { lineageId: round.lineageId, ordinal: round.ordinal + 1 }
    if (budget !== undefined && advanced.ordinal >= budget) {
      return yield* Effect.fail(
        new Flow.MaxRoundsExceeded({
          flowName: options.flowName,
          lineageId: advanced.lineageId,
          maxRounds: budget,
          roundOrdinal: advanced.ordinal,
          message: `Lineage ${advanced.lineageId} asked for round ${advanced.ordinal} of "${options.flowName}", ` +
            `which is past its declared maxRounds of ${budget}. Raise the budget, or make the body's branch settle ` +
            "with Flow.done sooner."
        })
      )
    }
    return { round: advanced, executionId: yield* executionId(advanced) }
  })
