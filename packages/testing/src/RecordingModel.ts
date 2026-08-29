/**
 * A live model wrapped so every call it makes is recorded.
 *
 * This is the other half of `RecordedModel`: it produces the fixtures that
 * module replays. The recorder is a `/model/Model`, not a `ModelLike`, because
 * it wraps the real provider seam the code under test already talks to.
 *
 * @since 0.0.0
 */
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { Effect, Exit, type Layer, Stream } from "effect"
import { type RecordedCall, recordedRequest } from "./Fixture.ts"
import type { ModelErrorLike, ModelEventLike } from "./ModelLike.ts"

/**
 * Where a recorder sends each completed call.
 *
 * The sink cannot fail and needs no services, so wrapping a model never widens
 * its stream's error channel or its requirements.
 *
 * @category models
 * @since 0.0.0
 */
export type Sink = (call: RecordedCall) => Effect.Effect<void>

const recordedFailure = (error: Model.ModelFailure): ModelErrorLike | undefined =>
  error instanceof ModelError
    ? {
      code: error.code,
      message: error.message,
      retryAfterMillis: error.retryAfterMillis,
      resetAtEpochMillis: error.resetAtEpochMillis,
      resetSource: error.resetSource,
      providerCode: error.providerCode,
      requestId: error.requestId,
      httpStatus: error.httpStatus
    }
    : undefined

/**
 * Wraps a live model so each call is written to `sink` when its stream ends.
 *
 * The recorder flushes on a settled stream and on a provider failure, and stays
 * silent otherwise. Interruption and a defect both leave a truncated exchange:
 * recording one would write a stream with no `settle` event, which replays as
 * an aborted turn and poisons any cache built from the same fixture. A
 * `PermissionRequired`, `PermissionDenied`, or `GrantStoreError` failure is not
 * recorded either, because the kernel refused the call before the provider saw
 * it, so there is no provider exchange to record; the failure still reaches the
 * caller unchanged.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (live: Model.Model, sink: Sink): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const events: Array<ModelEventLike> = []
        let failure: ModelErrorLike | undefined
        return live.stream(request).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              events.push(event)
            })
          ),
          Stream.tapError((error) =>
            Effect.sync(() => {
              failure = recordedFailure(error)
            })
          ),
          // `onExit` rather than `ensuring`: the exit is what separates a
          // settled call from an interrupted one, and only the settled call
          // belongs in a fixture.
          Stream.onExit((exit) =>
            Exit.isSuccess(exit) || failure !== undefined
              ? sink({
                request: recordedRequest(request),
                model: request.modelId,
                events: [...events],
                ...(failure === undefined ? {} : { failure })
              })
              : Effect.void
          )
        )
      })
  })

/**
 * Provides a recording model over a live one.
 *
 * @category layers
 * @since 0.0.0
 */
export const layer = (live: Model.Model, sink: Sink): Layer.Layer<Model.Model> => Model.layer(make(live, sink))
