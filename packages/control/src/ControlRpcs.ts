/**
 * Schema-backed RPC projection of the control service.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"
import {
  AlreadyResolved,
  ClaimLost,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  LaunchFailed,
  NoMatchingWait,
  PersistenceError,
  PlanDigestMismatch,
  RunNotFound,
  TransportError,
  Unauthorized,
  Unavailable
} from "./ControlError.ts"
import {
  ApprovalPayload,
  ControlEvent,
  Envelope,
  FlowId,
  IdempotencyKey,
  ListRequest,
  ListResponse,
  PlanCard,
  type Principal,
  Receipt,
  RunId,
  SignalPayload,
  SteerMessage,
  WatchFilter
} from "./ControlSchema.ts"

/**
 * Authenticated principal made available to control RPC handlers.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class ControlPrincipal extends Context.Service<ControlPrincipal, typeof Principal.Type>()(
  "/control/ControlPrincipal"
) {}

/**
 * Middleware boundary that authenticates control RPC requests.
 *
 * @category middleware
 * @since 0.1.0
 * @slop
 */
export class ControlAuth extends RpcMiddleware.Service<ControlAuth, {
  provides: ControlPrincipal
}>()("/control/ControlAuth", { error: Unauthorized }) {}

const PlanInput = Schema.Struct({
  flowId: FlowId,
  input: Schema.Json,
  idempotencyKey: Schema.optional(IdempotencyKey)
})

const RunInput = Schema.Union([
  Schema.TaggedStruct("Plan", {
    planId: Schema.String,
    digest: Schema.String,
    envelope: Envelope,
    idempotencyKey: IdempotencyKey
  }),
  Schema.TaggedStruct("Resume", { runId: RunId, idempotencyKey: IdempotencyKey })
])

// Principal is deliberately absent: the server supplies it through ControlAuth.
const ApprovalInput = ApprovalPayload

const SteerInput = Schema.Struct({
  runId: RunId,
  message: SteerMessage,
  idempotencyKey: IdempotencyKey
})

const SignalInput = Schema.Struct({
  runId: RunId,
  signal: SignalPayload,
  idempotencyKey: IdempotencyKey
})

const RunMutationInput = Schema.Struct({ runId: RunId, idempotencyKey: IdempotencyKey })

/**
 * A cancel carries the operator's stated reason; a resume does not.
 *
 * The reason is on the wire because attribution is written where the
 * cancellation is decided, and a remote operator decides it here. The
 * principal is deliberately NOT on the wire: the server stamps the identity it
 * authenticated, so a client cannot name someone else.
 */
const CancelInput = Schema.Struct({
  ...RunMutationInput.fields,
  reason: Schema.optional(Schema.String)
})

const mutationErrors = Schema.Union([RunNotFound, ClaimLost, PersistenceError, Unavailable])

/**
 * The ten remote procedures corresponding to `Control` operations.
 *
 * @category groups
 * @since 0.1.0
 * @slop
 */
export const ControlRpcs = RpcGroup.make(
  Rpc.make("Plan", {
    payload: PlanInput,
    success: PlanCard,
    error: Schema.Union([FlowNotFound, InvalidInput, PersistenceError, Unavailable])
  }),
  Rpc.make("Run", {
    payload: RunInput,
    success: Receipt,
    error: Schema.Union([
      RunNotFound,
      PlanDigestMismatch,
      EnvelopeMismatch,
      ClaimLost,
      LaunchFailed,
      PersistenceError,
      Unavailable
    ])
  }),
  Rpc.make("Approve", {
    payload: ApprovalInput,
    success: Receipt,
    error: Schema.Union([
      PlanDigestMismatch,
      EnvelopeMismatch,
      AlreadyResolved,
      RunNotFound,
      PersistenceError,
      Unavailable
    ])
  }),
  Rpc.make("Deny", {
    payload: ApprovalInput,
    success: Receipt,
    error: Schema.Union([
      PlanDigestMismatch,
      EnvelopeMismatch,
      AlreadyResolved,
      RunNotFound,
      PersistenceError,
      Unavailable
    ])
  }),
  Rpc.make("Steer", {
    payload: SteerInput,
    success: Receipt,
    error: Schema.Union([RunNotFound, PersistenceError, Unavailable])
  }),
  Rpc.make("Signal", {
    payload: SignalInput,
    success: Receipt,
    error: Schema.Union([RunNotFound, NoMatchingWait, PersistenceError, Unavailable])
  }),
  Rpc.make("Cancel", { payload: CancelInput, success: Receipt, error: mutationErrors }),
  Rpc.make("Resume", { payload: RunMutationInput, success: Receipt, error: mutationErrors }),
  Rpc.make("List", {
    payload: ListRequest,
    success: ListResponse,
    error: Schema.Union([
      RunNotFound,
      FlowNotFound,
      PlanDigestMismatch,
      EnvelopeMismatch,
      ClaimLost,
      AlreadyResolved,
      InvalidInput,
      Unauthorized,
      Unavailable,
      TransportError,
      PersistenceError,
      LaunchFailed,
      NoMatchingWait
    ])
  }),
  Rpc.make("Watch", {
    payload: WatchFilter,
    success: ControlEvent,
    error: Schema.Union([
      RunNotFound,
      FlowNotFound,
      PlanDigestMismatch,
      EnvelopeMismatch,
      ClaimLost,
      AlreadyResolved,
      InvalidInput,
      Unauthorized,
      Unavailable,
      TransportError,
      PersistenceError,
      LaunchFailed,
      NoMatchingWait
    ]),
    stream: true
  })
).middleware(ControlAuth)

/**
 * Header authenticator used by the control RPC boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Authenticator {
  readonly authenticate: (
    headers: Readonly<Record<string, string>>
  ) => Effect.Effect<typeof Principal.Type, Unauthorized>
}

/**
 * Configuration for the single-token bearer authenticator.
 *
 * Every request carrying the configured token receives the same principal.
 * This is the intentionally small alpha trust boundary, not a per-user
 * authorization system.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BearerAuthOptions {
  readonly token: string
  readonly principal: Omit<typeof Principal.Type, "stampedAt">
  readonly now?: (() => number) | undefined
}

const authorizationHeader = (headers: Readonly<Record<string, string>>): string | undefined => {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") return value
  }
  return undefined
}

const bearerToken = (headers: Readonly<Record<string, string>>): string | undefined => {
  const authorization = authorizationHeader(headers)
  if (authorization === undefined) return undefined
  const match = /^Bearer[\t ]+([^\t ]+)$/i.exec(authorization)
  return match?.[1]
}

const encoder = new TextEncoder()

/**
 * Compares UTF-8 credentials without returning early for a secret-dependent
 * byte or length difference.
 */
const constantTimeTokenEqual = (expected: string, actual: string): boolean => {
  const expectedBytes = encoder.encode(expected)
  const actualBytes = encoder.encode(actual)
  const length = Math.max(expectedBytes.length, actualBytes.length)
  let difference = expectedBytes.length ^ actualBytes.length

  for (let index = 0; index < length; index++) {
    difference |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0)
  }

  return difference === 0
}

/**
 * Authenticates one shared bearer token and stamps its server-owned principal.
 * Missing, malformed, empty, and incorrect credentials all fail closed with
 * the same `Unauthorized` response.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const bearerAuthenticator = (options: BearerAuthOptions): Authenticator => ({
  authenticate: (headers) => {
    const credential = bearerToken(headers)
    return options.token.length > 0 && credential !== undefined && constantTimeTokenEqual(options.token, credential)
      ? Effect.succeed({
        ...options.principal,
        stampedAt: options.now?.() ?? Date.now()
      })
      : Effect.fail(new Unauthorized({ message: "A valid bearer credential is required" }))
  }
})

/**
 * Provides `ControlAuth` from a transport-header authenticator.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerAuth = (authenticator: Authenticator) =>
  Layer.succeed(
    ControlAuth,
    (effect, options) =>
      Effect.flatMap(
        authenticator.authenticate(options.headers),
        (principal) => Effect.provideService(effect, ControlPrincipal, principal)
      )
  )

/**
 * Provides `ControlAuth` using one shared bearer token.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerBearerAuth = (options: BearerAuthOptions) => layerAuth(bearerAuthenticator(options))

/**
 * Permissive authentication middleware for tests and trusted in-process use.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoopAuth = (principal: typeof Principal.Type = {
  id: "test-principal",
  kind: "test",
  stampedAt: 0
}) => layerAuth({ authenticate: () => Effect.succeed(principal) })
