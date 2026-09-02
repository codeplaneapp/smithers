/**
 * RPC client layer projected back into the control service interface.
 *
 * @since 0.1.0
 */
import { Cause, Effect, Layer, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import { Control, make, type Service } from "./Control.ts"
import { type ControlError, ControlErrorSchema, TransportError } from "./ControlError.ts"
import { ControlRpcs } from "./ControlRpcs.ts"
import {
  ApprovalInputSchema,
  CancelInputSchema,
  ListRequest,
  PlanInputSchema,
  ReasonedMutationInputSchema,
  RunInputSchema,
  SignalInputSchema,
  SteerInputSchema,
  WatchFilter
} from "./ControlSchema.ts"

/**
 * Whether a value is one of the control plane's declared failures, as opposed
 * to a defect that escaped some other layer.
 *
 * Derived from `ControlError.ControlErrorSchema` rather than restated, so a new
 * error class cannot be a member of the union and a stranger to the client.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isControlError = Schema.is(ControlErrorSchema)

interface TransportClassification {
  readonly message: string
  readonly retryable: boolean
}

const requestEncoding: TransportClassification = {
  message: "The control request could not be encoded.",
  retryable: false
}

const responseDecoding: TransportClassification = {
  message: "The control response could not be decoded.",
  retryable: false
}

const connectionFailure: TransportClassification = {
  message: "The control server could not be reached.",
  retryable: true
}

const clientHttpFailure: TransportClassification = {
  message: "The control server rejected the HTTP request.",
  retryable: false
}

const serverHttpFailure: TransportClassification = {
  message: "The control server failed while handling the HTTP request.",
  retryable: true
}

const invalidClientUrl: TransportClassification = {
  message: "The control server URL is invalid.",
  retryable: false
}

const unknownClientFailure: TransportClassification = {
  message: "The control RPC client failed.",
  retryable: false
}

const transportError = (cause: unknown, classification: TransportClassification): TransportError =>
  new TransportError({
    ...classification,
    cause
  })

const statusFrom = (cause: unknown): number | undefined => {
  if (typeof cause !== "object" || cause === null || !("response" in cause)) return undefined
  const response = cause.response
  if (typeof response !== "object" || response === null || !("status" in response)) return undefined
  return typeof response.status === "number" ? response.status : undefined
}

const classifyRpcClientError = (error: RpcClientError.RpcClientError): TransportClassification => {
  const reason = error.reason
  switch (reason._tag) {
    case "HttpError": {
      switch (reason.kind) {
        case "TransportError":
          return connectionFailure
        case "EncodeError":
          return requestEncoding
        case "InvalidUrlError":
          return invalidClientUrl
        case "DecodeError":
        case "EmptyBodyError":
          return responseDecoding
        case "StatusCodeError": {
          // Effect's serializable HttpError keeps the concrete
          // StatusCodeError in `cause`. The wrapper has no separate status
          // field, so a hand-built wrapper without that cause cannot safely be
          // classified as retryable and falls back to the client class.
          const status = statusFrom(reason.cause)
          return status !== undefined && status >= 500 && status <= 599
            ? serverHttpFailure
            : clientHttpFailure
        }
      }
    }
    case "RpcClientDefect":
      return responseDecoding
    case "SocketReadError":
    case "SocketWriteError":
    case "SocketOpenError":
    case "SocketCloseError":
      return connectionFailure
    case "WorkerSpawnError":
    case "WorkerSendError":
    case "WorkerReceiveError":
    case "WorkerUnknownError":
      return unknownClientFailure
  }
}

const isRpcClientError = Schema.is(RpcClientError.RpcClientError)

const classify = (error: unknown): TransportClassification => {
  if (Schema.isSchemaError(error)) return responseDecoding
  if (isRpcClientError(error)) return classifyRpcClientError(error)
  return unknownClientFailure
}

const normalizedFailure = (cause: Cause.Cause<unknown>): Effect.Effect<never, ControlError> => {
  const failure = Cause.findError(cause)
  if (Result.isSuccess(failure)) {
    return Effect.fail(
      isControlError(failure.success)
        ? failure.success
        : transportError(failure.success, classify(failure.success))
    )
  }
  const defect = Cause.findDefect(cause)
  return Result.isSuccess(defect)
    ? Effect.fail(transportError(defect.success, classify(defect.success)))
    : Effect.failCause(cause as Cause.Cause<ControlError>)
}

const normalize = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ControlError, R> =>
  Effect.catchCause(effect, normalizedFailure)

type RequestEncoder = (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>

const encoder = (schema: Schema.Top): RequestEncoder =>
  // Every request schema in this module is service-free. `Schema.Top` erases
  // that fact to `unknown`, so restore it at this one construction boundary.
  Schema.encodeUnknownEffect(Schema.toCodecJson(schema)) as RequestEncoder

const planEncoder = encoder(PlanInputSchema)
const runEncoder = encoder(RunInputSchema)
const approvalEncoder = encoder(ApprovalInputSchema)
const steerEncoder = encoder(SteerInputSchema)
const signalEncoder = encoder(SignalInputSchema)
const cancelEncoder = encoder(CancelInputSchema)
const resumeEncoder = encoder(ReasonedMutationInputSchema)
const listEncoder = encoder(ListRequest)
const watchEncoder = encoder(WatchFilter)

const normalizeRequest = <A, E, R>(
  encode: RequestEncoder,
  input: unknown,
  request: () => Effect.Effect<A, E, R>
): Effect.Effect<A, ControlError, R> =>
  encode(input).pipe(
    Effect.mapError((cause) => transportError(cause, requestEncoding)),
    Effect.andThen(Effect.suspend(() => normalize(request())))
  )

const normalizeStream = <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, ControlError, R> =>
  Stream.catchCause(stream, (cause) => Stream.fromEffect(normalizedFailure(cause)))

const normalizeStreamRequest = <A, E, R>(
  encode: RequestEncoder,
  input: unknown,
  request: () => Stream.Stream<A, E, R>
): Stream.Stream<A, ControlError, R> =>
  Stream.unwrap(
    encode(input).pipe(
      Effect.mapError((cause) => transportError(cause, requestEncoding)),
      Effect.map(() => normalizeStream(request()))
    )
  )

/**
 * Client transport configuration. Unary procedures use HTTP at this URL;
 * `watch` uses the abstract WebSocket supplied by the platform layer.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ClientConfig {
  readonly url: string
  /** Bearer token attached to every HTTP RPC request when present. */
  readonly credential?: string | undefined
}

/**
 * Provides `Control` through an RPC client while preserving the local vtable.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (config: ClientConfig) => {
  const http = RpcClient.layerProtocolHttp({
    url: config.url,
    transformClient: (client) => {
      // The RPC protocol already admits HttpClientError, but transformClient's
      // generic signature cannot express that filtering adds the same error
      // its input client already carries.
      const checked = HttpClient.filterStatusOk(client) as typeof client
      return config.credential === undefined
        ? checked
        : HttpClient.mapRequest(checked, HttpClientRequest.bearerToken(config.credential))
    }
  })
  const websocket = RpcClient.layerProtocolSocket()
  return Layer.effect(
    Control,
    Effect.gen(function*() {
      // Built into the layer's own scope: `Effect.provide(layer)` would close
      // each protocol as soon as the client was constructed.
      const httpServices = yield* Layer.build(http)
      const websocketServices = yield* Layer.build(websocket)
      const unary = yield* RpcClient.make(ControlRpcs).pipe(Effect.provide(httpServices))
      const streaming = yield* RpcClient.make(ControlRpcs).pipe(Effect.provide(websocketServices))
      return make({
        plan: Effect.fn("Control.plan")((input) => normalizeRequest(planEncoder, input, () => unary.Plan(input))),
        run: Effect.fn("Control.run")((input) => normalizeRequest(runEncoder, input, () => unary.Run(input))),
        approve: Effect.fn("Control.approve")((input) =>
          normalizeRequest(approvalEncoder, input, () => unary.Approve(input))
        ),
        deny: Effect.fn("Control.deny")((input) => normalizeRequest(approvalEncoder, input, () => unary.Deny(input))),
        steer: Effect.fn("Control.steer")((input) => normalizeRequest(steerEncoder, input, () => unary.Steer(input))),
        signal: Effect.fn("Control.signal")((input) =>
          normalizeRequest(signalEncoder, input, () => unary.Signal(input))
        ),
        cancel: Effect.fn("Control.cancel")((input) =>
          normalizeRequest(cancelEncoder, input, () => unary.Cancel(input))
        ),
        resume: Effect.fn("Control.resume")((input) =>
          normalizeRequest(resumeEncoder, input, () => unary.Resume(input))
        ),
        list: Effect.fn("Control.list")((input) => normalizeRequest(listEncoder, input, () => unary.List(input))),
        watch: (input) => normalizeStreamRequest(watchEncoder, input, () => streaming.Watch(input))
      } as Service)
    })
  )
}
