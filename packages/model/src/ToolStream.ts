/**
 * Pure accumulation of fragmented provider tool-call arguments.
 *
 * @since 0.1.0
 */
import { Option, Schema } from "effect"
import { ModelError } from "./ModelError.ts"
import { JsonObject } from "./ModelRequest.ts"

/**
 * An unfinished streamed tool call.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface OpenToolCall {
  readonly callId: string
  readonly name: string
  readonly fragments: ReadonlyArray<string>
}

/**
 * Tool-call accumulator state.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface State {
  readonly open: ReadonlyArray<OpenToolCall>
}

/**
 * A completed provider tool call with its validated JSON argument text.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Completed {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

/**
 * The result of completing one streamed tool call.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type EndResult = { readonly state: State; readonly completed: Completed } | ModelError

/**
 * The result of flushing all tool calls left open by an interrupted stream.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface FlushResult {
  readonly state: State
  readonly completed: ReadonlyArray<Completed>
}

const invalidOutput = (message: string): ModelError => new ModelError({ code: "invalid_provider_output", message })
const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonObject)
)

const find = (state: State, callId: string): OpenToolCall | undefined =>
  state.open.find((entry) => entry.callId === callId)

/**
 * Creates an empty tool-call accumulator.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const initial = (): State => ({ open: [] })

/**
 * Starts recording fragments for a provider tool call.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const start = (state: State, call: { readonly callId: string; readonly name: string }): State => ({
  open: [...state.open.filter((entry) => entry.callId !== call.callId), { ...call, fragments: [] }]
})

/**
 * Appends an argument fragment to an open provider tool call.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const delta = (state: State, callId: string, fragment: string): State => ({
  open: state.open.map((entry) =>
    entry.callId === callId ? { ...entry, fragments: [...entry.fragments, fragment] } : entry
  )
})

/**
 * Completes a tool call and validates its reassembled argument JSON.
 *
 * This is the strict half of the package's two policies for one condition:
 * argument text that is not a JSON object fails with
 * `invalid_provider_output`, because a live stream that cannot say what the
 * model asked for must not hand a guess to a tool. {@link flushAborted} and
 * `ModelEvent.settledMessage` take the lenient half for a stream that has
 * already ended, substituting `"{}"` so the journaled turn stays decodable.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const end = (state: State, callId: string): EndResult => {
  const call = find(state, callId)
  if (call === undefined) {
    return invalidOutput(`Received completion for unknown tool call ${callId}`)
  }
  const arguments_ = call.fragments.join("") || "{}"
  if (Option.isNone(decodeArguments(arguments_))) {
    return invalidOutput(`Invalid JSON input for streamed tool call ${call.name}`)
  }
  return {
    state: { open: state.open.filter((entry) => entry.callId !== callId) },
    completed: { callId: call.callId, name: call.name, arguments: arguments_ }
  }
}

/**
 * Settles unfinished calls after a stream halt. Empty or partial arguments are
 * represented as `{}` so the historical assistant turn remains resumable. This
 * is the lenient half of the split documented on {@link end}: a halted stream
 * is history, and history has to stay decodable.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const flushAborted = (state: State): FlushResult => ({
  state: initial(),
  completed: state.open.map((call) => ({
    callId: call.callId,
    name: call.name,
    arguments: (() => {
      const arguments_ = call.fragments.join("") || "{}"
      return Option.isSome(decodeArguments(arguments_)) ? arguments_ : "{}"
    })()
  }))
})
