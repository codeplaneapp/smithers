/**
 * Encoding a round's settlement so a terminal transition can never be lost.
 *
 * A run row leaves `running` only when the driver has bytes to write into
 * `state_json`, and those bytes come from the flow's OWN codec:
 * `Flow.Result({ success: flow.successSchema, error: flow.errorSchema })`.
 * A flow that declares `Schema.Unknown` for either channel — which is what
 * `@smthrs/agent`'s `agent/run` declares, because an agent run carries
 * whatever its body failed with — encodes that channel through `Schema.Json`,
 * and `Schema.Json` rejects every class instance: `SchemaAST.isJson` walks the
 * prototype chain and refuses anything that is not a plain object or an array.
 * Every `Data.TaggedError` in this repository is therefore unencodable through
 * such a flow, `HarnessError` and `ModelError` included.
 *
 * Guarding the terminal transition with `Effect.orDie` around that encode made
 * an unencodable failure fatal for the drain instead of terminal for the run.
 * The Phase 7 Plue cutover caught the whole chain: `engine-store: coordinated
 * drain failed for run-1 SchemaError: Expected JSON value at
 * ["exit"]["cause"][0]["error"]`, `engine.db` `flows_runs` left at `running`
 * with a dead owner pid while `control.db` said `failed`, and 86 seconds later
 * the next process's stale-running sweep stole the row, opened a second turn,
 * and billed the provider seat again for a run the control plane had closed.
 *
 * So the encode fails CLOSED here rather than open. The ordinary path is the
 * flow's own codec, unchanged. When that codec rejects the value, the result
 * is still written — as a JSON projection of what could not be encoded (tag,
 * code, message, a stack summary, and nested causes) inside a `Die` reason —
 * and the caller is told, through {@link EncodedResult.note}, that it must
 * settle the run `failed`. A settled run is never re-executed, which is the
 * durability promise rc-contract section 7 states as one terminal write.
 *
 * The projection is built as plain JSON rather than re-encoded through a
 * schema, so nothing in this module can raise. Its top-level object carries no
 * `message` key on purpose: `Schema.Defect` revives any JSON object that has a
 * string `message` as an `Error`, and a projection has to come back out of the
 * row as the structured record it went in as.
 *
 * @since 0.1.0
 */
import { Flow } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"

/**
 * The `_tag` every projection carries, so a reader of `state_json` can tell a
 * projected settlement from an encoded one without guessing.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const projectionTag = "flows/engine-store/UnencodableResult"

/**
 * How many `cause` links a value projection follows before it stops.
 *
 * A provider failure nests two or three deep (`HarnessError` over
 * `ModelError` over the transport error); the bound exists so a self-linking
 * cause chain cannot make the projection unbounded.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const maxCauseDepth = 4

/**
 * How many leading stack lines a value projection keeps.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const maxStackLines = 4

/**
 * How many characters any single projected string keeps.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const maxTextLength = 1024

/**
 * A JSON-safe summary of one unencodable value.
 *
 * `type` is the constructor name for an object and the `typeof` for anything
 * else, so `ModelError` and `"boom"` are distinguishable in the row.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface ValueProjection {
  readonly type: string
  readonly message: string
  readonly tag?: string
  readonly code?: string
  readonly stack?: string
  readonly cause?: ValueProjection
}

/**
 * A JSON-safe summary of one `Cause` reason.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface ReasonProjection {
  readonly _tag: "Fail" | "Die" | "Interrupt"
  readonly error?: ValueProjection
  readonly fiberId?: number
}

/**
 * The record written in place of a settlement the flow's codec rejected.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface ResultProjection {
  readonly _tag: typeof projectionTag
  readonly result: "Complete" | "Suspended" | "Handoff"
  readonly note: string
  readonly reasons: ReadonlyArray<ReasonProjection>
  readonly value: ValueProjection | null
}

/**
 * What {@link encode} produces: the bytes to persist, and — only when the
 * flow's codec rejected the settlement — the note describing why.
 *
 * A present `note` is an instruction to the caller, not decoration: the run
 * must reach a terminal `failed` row, because the alternative is the row this
 * lane exists to abolish, a `running` row whose owner is gone.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface EncodedResult {
  readonly encoded: unknown
  readonly note: string | undefined
}

const truncate = (value: string, limit: number): string => value.length <= limit ? value : `${value.slice(0, limit)}…`

/**
 * Renders any value as a bounded string without raising.
 *
 * `JSON.stringify` answers `undefined` for a function, a symbol, and
 * `undefined` itself, and throws on a circular structure; both are answered
 * with a shape marker rather than propagated, because this module runs on the
 * path that must never fail.
 */
const text = (value: unknown): string => {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? `[${typeof value}]` : json
  } catch {
    return "[unrepresentable]"
  }
}

/** The constructor name of an object, or `object` when it has none. */
const typeName = (value: object): string => {
  const name = (value as { readonly constructor?: { readonly name?: unknown } }).constructor?.name
  return typeof name === "string" && name.length > 0 ? name : "object"
}

/**
 * Projects one value — a typed error, a defect, a success value, a handoff
 * payload — into JSON.
 *
 * @since 0.1.0
 * @category conversions
 * @slop
 */
export const projectValue = (value: unknown, depth = 0): ValueProjection => {
  if (value === null || typeof value !== "object") {
    return {
      type: value === null ? "null" : typeof value,
      message: truncate(text(value), maxTextLength)
    }
  }
  const record = value as Record<string, unknown>
  const projection: {
    type: string
    message: string
    tag?: string
    code?: string
    stack?: string
    cause?: ValueProjection
  } = {
    type: typeName(value),
    message: truncate(typeof record["message"] === "string" ? record["message"] : text(value), maxTextLength)
  }
  if (typeof record["_tag"] === "string") projection.tag = record["_tag"]
  if (typeof record["code"] === "string") projection.code = record["code"]
  if (typeof record["stack"] === "string") {
    projection.stack = truncate(record["stack"].split("\n").slice(0, maxStackLines).join("\n"), maxTextLength)
  }
  if (record["cause"] !== undefined && depth < maxCauseDepth) {
    projection.cause = projectValue(record["cause"], depth + 1)
  }
  return projection
}

const projectReason = (reason: Cause.Reason<unknown>): ReasonProjection => {
  if (Cause.isFailReason(reason)) return { _tag: "Fail", error: projectValue(reason.error) }
  if (Cause.isDieReason(reason)) return { _tag: "Die", error: projectValue(reason.defect) }
  return reason.fiberId === undefined ? { _tag: "Interrupt" } : { _tag: "Interrupt", fiberId: reason.fiberId }
}

/**
 * Projects every reason of a cause, in order. An absent cause — a
 * `Flow.Suspended` that carries none — projects to no reasons.
 *
 * @since 0.1.0
 * @category conversions
 * @slop
 */
export const projectCause = (
  cause: Cause.Cause<unknown> | undefined
): ReadonlyArray<ReasonProjection> => cause === undefined ? [] : cause.reasons.map(projectReason)

/**
 * Projects a settlement the flow's codec rejected.
 *
 * @since 0.1.0
 * @category conversions
 * @slop
 */
export const projectResult = (
  result: Flow.Result<unknown, unknown>,
  note: string
): ResultProjection => {
  if (result._tag === "Suspended") {
    return { _tag: projectionTag, result: "Suspended", note, reasons: projectCause(result.cause), value: null }
  }
  if (result._tag === "Handoff") {
    return { _tag: projectionTag, result: "Handoff", note, reasons: [], value: projectValue(result.payload) }
  }
  return Exit.isSuccess(result.exit)
    ? { _tag: projectionTag, result: "Complete", note, reasons: [], value: projectValue(result.exit.value) }
    : { _tag: projectionTag, result: "Complete", note, reasons: projectCause(result.exit.cause), value: null }
}

/**
 * The encoded settlement written in place of one the codec rejected.
 *
 * A `Handoff` keeps its own shape, because its round settles `completed` with
 * a successor already created and the lineage has to stay readable. Everything
 * else becomes a failed `Complete`: a settlement whose bytes the codec refuses
 * is not resumable and not answerable, so the only honest durable record is
 * that the round failed, with the projection as its defect.
 */
const degrade = (result: Flow.Result<unknown, unknown>, projection: ResultProjection): unknown =>
  result._tag === "Handoff"
    ? { _tag: "Handoff", flow: result.flow, payload: projection }
    : { _tag: "Complete", exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: projection }] } }

/**
 * Encodes a round's settlement through the flow's own codec, and — when that
 * codec rejects it — through a JSON projection instead.
 *
 * The returned effect has no error channel and dies for nothing: a caller on
 * the terminal-transition path can always write the row it holds.
 *
 * @since 0.1.0
 * @category conversions
 * @slop
 */
export const encode = (
  flow: Flow.Any,
  result: Flow.Result<unknown, unknown>
): Effect.Effect<EncodedResult> =>
  Schema.encodeEffect(
    Schema.toCodecJson(Flow.Result({
      success: flow.successSchema,
      error: flow.errorSchema
    }))
  )(result).pipe(
    Effect.map((encoded): EncodedResult => ({ encoded, note: undefined })),
    Effect.catchCause((cause) => {
      const note = truncate(Cause.pretty(cause), maxTextLength)
      return Effect.as(
        Effect.logWarning(
          `engine-store: the settlement of ${flow._tag} could not be encoded through its own codec; persisting a JSON projection so the run still settles`,
          cause
        ),
        { encoded: degrade(result, projectResult(result, note)), note } satisfies EncodedResult
      )
    })
  ) as Effect.Effect<EncodedResult>
