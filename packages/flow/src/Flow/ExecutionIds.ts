/**
 * The ambient source of execution identity, for a flow executed without one.
 *
 * Identity has three sources, in this order: the `executionId` the caller
 * named, the `idempotencyKey` the flow declared, and — when neither exists —
 * the source in this module. The first two are decisions an author made at the
 * call site or the declaration site; the third is a decision the *host* makes
 * once, for every flow it drives, which is why it is a context reference and
 * not another option on `execute`.
 *
 * The default derives the id from the flow tag and the payload's canonical
 * form, so `yield* Flow.execute(payload)` runs without ceremony and re-running
 * the same invocation lands on the same execution. A host for which two equal
 * payloads are two unrelated pieces of work — a coding agent running one
 * request per user is the case `packages/engine/VENDOR.md` names — installs its
 * own source with {@link layerExecutionIds} and scopes identity to whatever
 * makes runs related there.
 *
 * @since 0.1.0
 */
import { Sha256 } from "@smthrs/crypto"
import { Key } from "@smthrs/keys"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { ExecutionIdRequired } from "./ExecutionIdRequired.ts"
import type { Any } from "./Flow.ts"

/**
 * Mints the execution id of an invocation that named none.
 *
 * It is consulted only after the two explicit sources are absent, and it runs
 * before the runtime is read, so a source that cannot name the invocation
 * fails the execution rather than starting one under a guessed identity.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ExecutionIdSource {
  readonly mint: (
    flow: Any,
    payload: unknown
  ) => Effect.Effect<string, never, Crypto.Crypto>
}

/**
 * The canonical key of an invocation: the flow's own payload codec, then RFC
 * 8785, then SHA-256.
 *
 * Encoding first is what makes the key agree with the durable driver, which
 * compares the ENCODED payload when it decides whether an existing run row is
 * the same invocation. A payload with no canonical form — a non-finite number,
 * a lone surrogate, a cycle — has no derivable identity at all, so it fails
 * here instead of hashing something approximate.
 *
 * @private
 */
const canonicalKey = (
  flow: Any,
  payload: unknown
): Effect.Effect<string, ExecutionIdRequired, Crypto.Crypto> =>
  (Schema.encodeEffect(Schema.toCodecJson(flow.payloadSchema))(payload) as Effect.Effect<unknown, unknown>).pipe(
    Effect.flatMap((encoded) => Schema.decodeUnknownEffect(Key)(encoded)),
    Effect.mapError(() => new ExecutionIdRequired({ flowName: flow._tag }))
  )

/**
 * The default source: a deterministic id over the flow tag and the payload's
 * canonical form.
 *
 * Same tag and same encoded payload derive the same id, which is exactly the
 * pair the durable driver already treats as one invocation, so a re-drive of a
 * crashed program re-attaches to the run it left behind instead of opening a
 * second one.
 *
 * The tag and canonical payload key are JSON-tuple framed before hashing.
 * Their strings are used exactly as given and encoded as UTF-8, with no Unicode
 * normalization. This preimage encoding freezes at rc.0.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const derived: ExecutionIdSource = {
  mint: (flow, payload) =>
    canonicalKey(flow, payload).pipe(
      // The JSON tuple prevents delimiter splicing. This exact framing freezes at rc.0.
      Effect.flatMap((key) => Effect.orDie(Schema.decodeUnknownEffect(Sha256)(JSON.stringify([flow._tag, key])))),
      Effect.orDie
    )
}

/**
 * Context reference carrying the host's execution-id source, defaulting to
 * {@link derived}.
 *
 * @category idempotency
 * @since 0.1.0
 * @slop
 */
export const CurrentExecutionIds = Context.Reference<ExecutionIdSource>(
  "@smthrs/flow/Flow/CurrentExecutionIds",
  { defaultValue: () => derived }
)

/**
 * Declares the host's execution-id source as a layer.
 *
 * **When to use**
 *
 * Use it when equal payloads of one flow are NOT one piece of work in this
 * host — a session, a request, or a workspace is what separates them — and
 * scope the minted id to that. Callers that name an `executionId` and flows
 * that declare an `idempotencyKey` are unaffected: both are decided before the
 * source is consulted.
 *
 * @category idempotency
 * @since 0.1.0
 * @slop
 */
export const layerExecutionIds = (
  source: ExecutionIdSource
): Layer.Layer<never> => Layer.succeed(CurrentExecutionIds)(source)
