/**
 * Transcript projection from durable journal entries.
 *
 * The transcript grows: what the model saw is what it said plus what the
 * harness answered, in journal order. A `continue` used to be able to replace
 * the whole projection with a list of messages the cell had written for its
 * successor, and that branch is gone with the surface that produced it — a
 * journal from those waves still decodes, and its `context` entries are simply
 * not read.
 *
 * @since 0.1.0
 */
import type { JournalEvent } from "@smthrs/journal"
import { ModelRequest } from "@smthrs/model"
import { Result, Schema } from "effect"
import * as AgentEvent from "./AgentEvent.ts"
import type * as Cell from "./Cell.ts"
import type * as EngineLike from "./EngineLike.ts"

/**
 * Stable failures produced while projecting a durable transcript.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const TranscriptErrorCode = Schema.Literals(["projection_failed"])

/**
 * Stable failures produced while projecting a durable transcript.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TranscriptErrorCode = typeof TranscriptErrorCode.Type

/**
 * Stable failures produced while projecting a durable transcript.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class TranscriptError extends Schema.TaggedError<TranscriptError>()("flows/harness/TranscriptError", {
  code: TranscriptErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * The kind and message of one projected transcript item.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ProjectedMessage {
  readonly kind: "transcript" | "summary" | "steering"
  readonly message: ModelRequest.Message
}

/**
 * A projection with the compaction replacement identity, when one was recorded.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ProjectedState {
  readonly messages: ReadonlyArray<ProjectedMessage>
  readonly replaced?: string | undefined
  readonly cell: CellEvidence
}

/**
 * Schema-decoded cell evidence consumed while rebuilding a journal.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CellEvidence {
  readonly produced: ReadonlyArray<Cell.Source>
  readonly callsStarted: ReadonlyArray<Cell.Call>
  readonly callsSettled: ReadonlyArray<AgentEvent.CellCallSettled>
  readonly settled: ReadonlyArray<AgentEvent.CellSettled>
  readonly transitions: ReadonlyArray<Cell.Transition>
  readonly suspensions: ReadonlyArray<EngineLike.SuspendReason>
  readonly aborts: ReadonlyArray<string>
}

const eventType = {
  aborted: "flows.harness.aborted.v1",
  cellCallSettled: "flows.harness.cell-call-settled.v1",
  cellCallStarted: "flows.harness.cell-call-started.v1",
  cellProduced: "flows.harness.cell-produced.v1",
  cellSettled: "flows.harness.cell-settled.v1",
  compactionSettled: "flows.harness.compaction-settled.v1",
  modelSettled: "flows.harness.model-settled.v1",
  steeringDrained: "flows.harness.steering-drained.v1",
  suspended: "flows.harness.suspended.v1",
  transitionApplied: "flows.harness.transition-applied.v1"
} as const

const projectionFailed = (entry: JournalEvent.Entry, cause: unknown): TranscriptError =>
  new TranscriptError({
    code: "projection_failed",
    message: `Invalid ${entry.eventType} payload at journal sequence ${entry.seq}`,
    cause
  })

const decode = <A>(
  decodePayload: (payload: unknown) => Result.Result<A, unknown>,
  entry: JournalEvent.Entry
): Result.Result<A, TranscriptError> =>
  Result.mapError(decodePayload(entry.payload), (cause) => projectionFailed(entry, cause))

const ordered = (entries: ReadonlyArray<JournalEvent.Entry>): ReadonlyArray<JournalEvent.Entry> =>
  [...entries].sort((left, right) => left.seq - right.seq)

const decodeModelSettled = Schema.decodeUnknownResult(AgentEvent.ModelSettled)
const decodeSteeringDrained = Schema.decodeUnknownResult(AgentEvent.SteeringDrained)
const decodeCompactionSettled = Schema.decodeUnknownResult(AgentEvent.CompactionSettled)
const decodeCellProduced = Schema.decodeUnknownResult(AgentEvent.CellProduced)
const decodeCellCallStarted = Schema.decodeUnknownResult(AgentEvent.CellCallStarted)
const decodeCellCallSettled = Schema.decodeUnknownResult(AgentEvent.CellCallSettled)
const decodeCellSettled = Schema.decodeUnknownResult(AgentEvent.CellSettled)
const decodeTransitionApplied = Schema.decodeUnknownResult(AgentEvent.TransitionApplied)
const decodeSuspended = Schema.decodeUnknownResult(AgentEvent.Suspended)
const decodeAborted = Schema.decodeUnknownResult(AgentEvent.Aborted)

const transcriptMessage = (
  message: ModelRequest.AssistantMessage
): ModelRequest.AssistantMessage =>
  message.stopReason === "error" || message.stopReason === "aborted"
    ? new ModelRequest.AssistantMessage({
      role: "assistant",
      content: message.content.map((part) =>
        part.type === "thinking"
          ? ModelRequest.ThinkingPart.make({ text: part.text })
          : part
      ),
      stopReason: message.stopReason
    })
    : message

/**
 * Projects journal events into their model-visible transcript state as typed
 * data, preserving malformed payload failures instead of throwing.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export const projectStateResult = (
  entries: ReadonlyArray<JournalEvent.Entry>
): Result.Result<ProjectedState, TranscriptError> => {
  const events = ordered(entries)
  const produced: Array<Cell.Source> = []
  const callsStarted: Array<Cell.Call> = []
  const callsSettled: Array<AgentEvent.CellCallSettled> = []
  const settledCells: Array<AgentEvent.CellSettled> = []
  const transitions: Array<Cell.Transition> = []
  const suspensions: Array<EngineLike.SuspendReason> = []
  const aborts: Array<string> = []
  let compaction:
    | {
      readonly sequence: number
      readonly payload: AgentEvent.CompactionSettled
    }
    | undefined

  for (const entry of events) {
    switch (entry.eventType) {
      case eventType.cellProduced: {
        const decoded = decode(decodeCellProduced, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        produced.push(decoded.success.cell)
        break
      }
      case eventType.cellCallStarted: {
        const decoded = decode(decodeCellCallStarted, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        callsStarted.push(decoded.success.call)
        break
      }
      case eventType.cellCallSettled: {
        const decoded = decode(decodeCellCallSettled, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        callsSettled.push(decoded.success)
        break
      }
      case eventType.cellSettled: {
        const decoded = decode(decodeCellSettled, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        settledCells.push(decoded.success)
        break
      }
      case eventType.transitionApplied: {
        const decoded = decode(decodeTransitionApplied, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        transitions.push(decoded.success.transition)
        break
      }
      case eventType.suspended: {
        const decoded = decode(decodeSuspended, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        suspensions.push(decoded.success.reason)
        break
      }
      case eventType.aborted: {
        const decoded = decode(decodeAborted, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        aborts.push(decoded.success.reason)
        break
      }
      case eventType.compactionSettled: {
        const decoded = decode(decodeCompactionSettled, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        compaction = {
          sequence: entry.seq,
          payload: decoded.success
        }
        break
      }
    }
  }

  const messages: Array<ProjectedMessage> = []
  if (compaction !== undefined) {
    messages.push({
      kind: "summary",
      message: compaction.payload.summary
    })
  }

  for (const entry of events) {
    if (compaction !== undefined && entry.seq <= compaction.sequence) continue
    switch (entry.eventType) {
      case eventType.modelSettled: {
        const decoded = decode(decodeModelSettled, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        if (decoded.success.message.content.length === 0) break
        messages.push({ kind: "transcript", message: transcriptMessage(decoded.success.message) })
        break
      }
      case eventType.steeringDrained: {
        const decoded = decode(decodeSteeringDrained, entry)
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        for (const message of decoded.success.messages) {
          messages.push({ kind: "steering", message })
        }
        break
      }
      case eventType.cellSettled: {
        const decoded = decode(decodeCellSettled, entry)
        /* v8 ignore next -- the first pass ran `decodeCellSettled` over every `cellSettled` entry of this same `events` array and returned on failure, and `decode` is a pure function of `entry.payload`, so re-decoding an entry that survived that pass cannot fail; the branch exists because `Result` has no way to carry that proof */
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure)
        if (decoded.success.outcome._tag === "rejected") {
          messages.push({
            kind: "transcript",
            message: ModelRequest.Message.user(decoded.success.outcome.message)
          })
        } else if (decoded.success.outcome._tag === "raised") {
          messages.push({
            kind: "transcript",
            message: ModelRequest.Message.user(
              `The cell threw ${decoded.success.outcome.name}: ${decoded.success.outcome.message}. Emit a corrected cell.`
            )
          })
        }
        break
      }
    }
  }
  return Result.succeed({
    messages,
    replaced: compaction?.payload.replacedPrefixDigest,
    cell: {
      produced,
      callsStarted,
      callsSettled,
      settled: settledCells,
      transitions,
      suspensions,
      aborts
    }
  })
}

/**
 * Projects model-visible messages in canonical journal sequence order.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export const projectResult = (
  entries: ReadonlyArray<JournalEvent.Entry>
): Result.Result<ReadonlyArray<ModelRequest.Message>, TranscriptError> =>
  Result.map(projectStateResult(entries), (state) => state.messages.map((item) => item.message))
