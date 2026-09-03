import { Model, ModelError, ModelEvent, ModelRequest } from "@smthrs/model"
import { Effect, Layer, Stream } from "effect"

/**
 * One recorded provider step replayed by the fixture model.
 *
 * @category fixtures
 * @since 0.1.0
 */
export interface Step {
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
  readonly interruptAfterEvents?: boolean | undefined
}

/**
 * A deterministic sequence of recorded provider steps.
 *
 * @category fixtures
 * @since 0.1.0
 */
export type Script = ReadonlyArray<Step>

/**
 * Calls and requests observed by a scripted model.
 *
 * @category fixtures
 * @since 0.1.0
 */
export interface Recorder {
  readonly requests: Array<ModelRequest.ModelRequest>
}

/**
 * A scripted model together with its layer and recorder.
 *
 * @category fixtures
 * @since 0.1.0
 */
export interface Fixture {
  readonly model: Model.Model
  readonly layer: Layer.Layer<Model.Model>
  readonly recorder: Recorder
}

const text = (
  id: string,
  value: string
): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: value }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id })
]

/**
 * A model step that settles with one ordinary flow call.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const stopWithToolCalls: Step = {
  events: [
    ...text("text-tool", "I will call a tool."),
    ModelEvent.ModelEvent.ToolCallStart({
      type: "tool-call-start",
      id: "call-1",
      name: "alpha"
    }),
    ModelEvent.ModelEvent.ToolCallDelta({
      type: "tool-call-delta",
      id: "call-1",
      arguments: "{\"value\":\"one\"}"
    }),
    ModelEvent.ModelEvent.ToolCallEnd({
      type: "tool-call-end",
      id: "call-1"
    }),
    ModelEvent.ModelEvent.Usage({
      inputTokens: 10,
      outputTokens: 5
    }),
    ModelEvent.ModelEvent.Settle({
      type: "settle",
      stopReason: "tool-calls"
    })
  ]
}

/**
 * A model step that settles with final text and no tool calls.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const stopNoTools: Step = {
  events: [
    ...text("text-final", "done"),
    ModelEvent.ModelEvent.Usage({
      inputTokens: 4,
      outputTokens: 1
    }),
    ModelEvent.ModelEvent.Settle({
      type: "settle",
      stopReason: "stop"
    })
  ]
}

/**
 * A truncated model step whose apparently valid calls must all be rejected.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const lengthStop: Step = {
  events: [
    ModelEvent.ModelEvent.ToolCallStart({
      type: "tool-call-start",
      id: "length-call",
      name: "alpha"
    }),
    ModelEvent.ModelEvent.ToolCallDelta({
      type: "tool-call-delta",
      id: "length-call",
      arguments: "{\"value\":\"partial\"}"
    }),
    ModelEvent.ModelEvent.ToolCallEnd({
      type: "tool-call-end",
      id: "length-call"
    }),
    ModelEvent.ModelEvent.Settle({
      type: "settle",
      stopReason: "length"
    })
  ]
}

/**
 * A provider stream that emits progress but never records a settlement.
 *
 * @category fixtures
 * @since 0.1.0
 */
export const midStreamInterrupt: Step = {
  events: [
    ModelEvent.ModelEvent.TextStart({
      type: "text-start",
      id: "partial"
    }),
    ModelEvent.ModelEvent.TextDelta({
      type: "text-delta",
      id: "partial",
      text: "partial"
    })
  ],
  interruptAfterEvents: true
}

/**
 * Constructs a network-free model that replays one recorded sequence per
 * request.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (script: Script): Fixture => {
  const requests: Array<ModelRequest.ModelRequest> = []
  let index = 0
  const model = Model.make({
    stream: (request) => {
      requests.push(request)
      const step = script[index++]
      if (step === undefined) {
        return Stream.fail(
          new ModelError.ModelError({
            code: "invalid_provider_output",
            message: `No scripted model step at index ${index - 1}`
          })
        )
      }
      const events = Stream.fromIterable(step.events)
      return step.interruptAfterEvents === true
        ? Stream.concat(events, Stream.fromEffect(Effect.interrupt))
        : events
    }
  })
  return {
    model,
    layer: Model.layer(model),
    recorder: { requests }
  }
}
