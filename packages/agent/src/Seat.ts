/**
 * The seat: what a flow or an action declares to pick the model it runs on.
 *
 * A seat has two halves and they live in different places on purpose.
 *
 * The declared half is an ordinary string, and this module deliberately ships
 * no schema for it. It is what a markdown flow's `model:` frontmatter carries
 * and what {@link module:AgentAction}'s `seat` option takes, and it carries no
 * credentials, no endpoint, and no client: a declaration is portable, and a run
 * that reads one out of a repository must not be handed the keys with it. The
 * convention the Node CLI resolver understands is `provider:modelId`
 * (`anthropic:claude-sonnet-4-5`), with the provider ahead of the separator and
 * the model id after it. That convention belongs to the resolver, not to the
 * agent. A host that installs its own {@link module:SeatResolver} may accept
 * anything it likes, including a bare model id or a logical name like `fast` or
 * `reviewer`, because nothing below the resolver parses the string.
 *
 * The resolved half is {@link Seat}, which is what the agent actually runs on:
 * a live {@link Model.Model}, the {@link FlowEngineLike.RouteResolver} that
 * seals its requests, and the model's context window in tokens so compaction
 * has a real budget. Only a `SeatResolver` produces one, and a seat it cannot
 * turn into a route is a typed {@link SeatUnresolved} rather than a run that
 * fails halfway through.
 *
 * @since 0.1.0
 */
import type * as Model from "@smthrs/model/Model"
import { Schema } from "effect"
import type * as FlowEngineLike from "./FlowEngineLike.ts"

/**
 * One resolved seat: the id it was declared as, the model to stream from, the
 * route that seals its requests, and the model's context window so compaction
 * has a real budget.
 *
 * @category models
 * @since 0.1.0
 */
export interface Seat {
  /** The declared seat string this record was resolved from. */
  readonly id: string
  readonly model: Model.Model
  readonly route: FlowEngineLike.RouteResolver
  /** Zero disables compaction, so a resolver must never report it. */
  readonly contextWindowTokens: number
}

/**
 * Constructs a resolved seat.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (seat: Seat): Seat => seat

/**
 * A seat the host could not turn into a model route: an unknown provider, a
 * missing API key, an invalid endpoint.
 *
 * @category errors
 * @since 0.1.0
 */
export class SeatUnresolved extends Schema.TaggedError<SeatUnresolved>()(
  "@smthrs/agent/Seat/SeatUnresolved",
  {
    seat: Schema.String,
    message: Schema.String
  }
) {}

/**
 * The model id half of a seat string.
 *
 * A seat with no separator is its own model id: a bare model name is a
 * degenerate but legal seat, and splitting on a separator that is not there
 * would return the empty string and leave the context window sized for a model
 * called nothing.
 *
 * @category conversions
 * @since 0.1.0
 */
export const modelIdOf = (id: string): string => {
  const separator = id.indexOf(":")
  return separator < 0 ? id : id.slice(separator + 1)
}
