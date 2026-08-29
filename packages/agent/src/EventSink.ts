/**
 * The host seam that watches one model-backed step while it runs.
 *
 * {@link module:Agent} answers with a `Stream<AgentEvent>` and
 * {@link module:AgentAction} consumes the whole stream itself, because it owes
 * its caller one decoded value and the answer is only known at the last
 * `complete` transition. That is the right result and it left the events with
 * nowhere to go. A host rendering the run sees no token deltas, no produced
 * cell, and no calls until the step is over, so hosts re-implemented the loop
 * behind their own `Action` to reach the stream. This service removes that
 * reason to re-implement it. The step still buffers every event for the
 * decode; the sink is handed each one on the way past.
 *
 * The service is optional. `AgentAction` resolves it with
 * `Effect.serviceOption`, so a composition that provides none behaves exactly
 * as it did before this module existed, and providing one changes nothing
 * about the step's answer, its correction budget, or its failures.
 *
 * One constraint governs an implementation: {@link Service.emit} runs inside
 * the frame that produced the event, and that frame holds the engine's write
 * transaction. An `emit` that waits on a durable write waits on a writer that
 * is waiting on `emit`, and the run stalls. A sink pushes onto a queue, writes
 * to a socket, or resolves a deferred; it does not journal.
 *
 * @since 0.1.0
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import { Context, Effect, Layer } from "effect"

/**
 * The sink: one event in, nothing out.
 *
 * The method cannot fail. A host's rendering is not the run's business, so a
 * sink that cannot deliver handles that itself rather than failing a step that
 * is otherwise making progress.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class EventSink extends Context.Service<EventSink, Service>()(
  "@smthrs/agent/EventSink"
) {}

/**
 * Builds a {@link Service} from an implementation of its one method.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => EventSink.of(implementation)

/**
 * A {@link Service} that drops every event.
 *
 * This is what a composition that provides no sink already does, written down
 * so a test can provide the absence explicitly. Overrides replace the method.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    emit: () => Effect.void,
    ...overrides
  })

/**
 * Provides {@link EventSink} from an implementation.
 *
 * @example
 * ```ts
 * import * as EventSink from "@smthrs/agent/EventSink"
 * import * as Effect from "effect/Effect"
 *
 * const frames: Array<string> = []
 * const layer = EventSink.layer({
 *   emit: (event) => Effect.sync(() => frames.push(event._tag))
 * })
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (implementation: Service): Layer.Layer<EventSink> => Layer.succeed(EventSink)(make(implementation))

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<EventSink> =>
  Layer.succeed(EventSink)(makeNoop(overrides))
