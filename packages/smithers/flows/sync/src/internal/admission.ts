/** Admission of host and transport values before any progress is committed.
 * @since 1.0.0-rc.0
 */
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { BranchId, branchOfRunId, CommandEvent, CommandEventPayload } from "../BranchProtocol.ts"
import { SyncError } from "../SyncError.ts"
import { causeCode } from "./causeText.ts"

/** Decode a boundary value while retaining a safe cause classification.
 * @category validation
 * @since 1.0.0-rc.0
 */
export const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
  code: "decode_failed" | "invalid_request" = "decode_failed"
): Effect.Effect<S["Type"], SyncError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (cause) => new SyncError({ code, message: "Invalid sync envelope", cause: causeCode(cause) })
  })

const decodeEntries = Schema.decodeUnknownSync(Schema.Array(JournalEvent.Entry))
const decodeJson = Schema.decodeUnknownSync(Schema.Struct({ payload: Schema.Json, meta: Schema.Json }))
const decodeCommand = Schema.decodeUnknownSync(CommandEventPayload)
const decodeBranch = Schema.decodeUnknownSync(Schema.Struct({ branchId: Schema.optional(BranchId) }))

/** Known branch records fail closed; unknown namespaces remain open JSON envelopes.
 * Defaults on persisted command args/target keep their existing additive schema meaning.
 * @category validation
 * @since 1.0.0-rc.0
 */
export const records = (
  values: ReadonlyArray<JournalEvent.Entry>
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, SyncError> =>
  Effect.try({
    try: () => {
      // Capture getters once and detach nested payloads before any application
      // callback can mutate the producer's next entry after admission.
      const captured = decodeEntries(structuredClone(values))
      for (const entry of captured) {
        decodeJson(entry)
        if (entry.eventType !== CommandEvent) continue
        decodeCommand(entry.payload)
        const identity = decodeBranch(entry.payload)
        if (identity.branchId !== undefined && identity.branchId !== branchOfRunId(entry.runId)) {
          throw new SyncError({
            code: "protocol_violation",
            message: "Command belongs to another branch",
            cause: "foreign_branch"
          })
        }
      }
      return captured
    },
    catch: (cause) =>
      cause instanceof SyncError
        ? cause
        : new SyncError({ code: "decode_failed", message: "Invalid sync record", cause: causeCode(cause) })
  })

/** Admit an entire run batch before its caller publishes or updates a cursor.
 * @category validation
 * @since 1.0.0-rc.0
 */
export const entries = (
  values: ReadonlyArray<JournalEvent.Entry>,
  runId: JournalEvent.RunId,
  after: number
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, SyncError> =>
  Effect.gen(function*() {
    const captured = yield* records(values)
    let previous = after
    for (const entry of captured) {
      if (entry.runId !== runId || entry.seq <= previous) {
        return yield* Effect.fail(
          new SyncError({
            code: "protocol_violation",
            message: "Journal batch must belong to the requested run and ascend strictly above its cursor",
            cause: entry.runId !== runId ? "foreign_run" : "non_monotonic_sequence"
          })
        )
      }
      previous = entry.seq
    }
    return captured
  })
