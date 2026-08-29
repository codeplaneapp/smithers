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
 * The round a lineage starts at: ordinal zero, with the caller's execution id
 * as the lineage id every later round derives from.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const initial = (executionId: string): Round => ({
  lineageId: executionId,
  ordinal: 0
})

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
export const executionId = (round: Round): Effect.Effect<string, never, Crypto.Crypto> =>
  Schema.decodeUnknownEffect(Sha256)(
    `flow-round-${round.lineageId}-${round.ordinal}`
  ).pipe(Effect.orDie)

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
  Flow.MaxRoundsExceeded,
  Crypto.Crypto
> =>
  Effect.suspend(() => {
    const advanced: Round = { lineageId: round.lineageId, ordinal: round.ordinal + 1 }
    const budget = options.maxRounds
    return budget !== undefined && advanced.ordinal >= budget
      ? Effect.fail(
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
      : Effect.map(executionId(advanced), (id) => ({ round: advanced, executionId: id }))
  })
