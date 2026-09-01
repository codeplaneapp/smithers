/**
 * Reusable schedule declarations shared by triggers.
 *
 * @see docs/specs/Concepts/Flow Triggers.md
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Cron from "./Cron.ts"
import { TriggerError } from "./TriggerError.ts"

/**
 * Schedule overlap policies.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Overlap = Schema.Literals(["skip", "buffer-one", "supersede"])

/**
 * Schedule overlap policy.
 *
 * @category models
 * @since 0.1.0
 */
export type Overlap = typeof Overlap.Type

/**
 * Schedule catch-up policies.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CatchUp = Schema.Literals(["none", "one", "all"])

/**
 * Schedule catch-up policy.
 *
 * @category models
 * @since 0.1.0
 */
export type CatchUp = typeof CatchUp.Type

/**
 * A reusable cron schedule and its overlap and catch-up policies.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Schedule = Schema.Struct({
  cron: Schema.NonEmptyString,
  timezone: Schema.optional(Schema.NonEmptyString),
  overlap: Overlap.pipe(Schema.withDecodingDefault(Effect.succeed("skip" as const))),
  catchUp: CatchUp.pipe(Schema.withDecodingDefault(Effect.succeed("none" as const))),
  maxCatchUp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

/**
 * A reusable cron schedule.
 *
 * @category models
 * @since 0.1.0
 */
export type Schedule = typeof Schedule.Type

/**
 * Refuses a declaration whose cron expression is malformed or which the
 * calendar never satisfies.
 *
 * The schema types `cron` as a non-empty string, which is as much as a field
 * schema can say: `0 0 30 2 *` passes every range check and matches no date.
 * Only the occurrence search knows that, so every declaration path runs it
 * here rather than leaving it to the tick that would have fired the trigger.
 *
 * @category constructors
 * @since 0.1.0
 */
export const validate = <A extends { readonly cron: string; readonly timezone?: string | undefined }>(
  declaration: A
): Effect.Effect<A, TriggerError> => Effect.as(Cron.parse(declaration.cron, declaration.timezone), declaration)

/**
 * Decodes and validates a schedule declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (input: unknown): Effect.Effect<Schedule, TriggerError> =>
  Schema.decodeUnknownEffect(Schedule)(input).pipe(
    Effect.mapError((cause) =>
      new TriggerError({
        code: "invalid_schedule",
        message: "Schedule declaration is invalid",
        cause
      })
    ),
    Effect.flatMap(validate)
  )
