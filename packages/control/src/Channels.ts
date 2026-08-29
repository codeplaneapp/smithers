/**
 * Channel contracts and the in-memory channel coordinator.
 *
 * A channel verifies opaque transport data before it decodes or maps it. The
 * resulting request is then dispatched through the Control service; channels
 * do not acquire an execution path of their own.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Ref, type Schema, Semaphore } from "effect"
import { Control } from "./Control.ts"
import { type ControlError, type InvalidInput, type Unauthorized, Unavailable } from "./ControlError.ts"
import type { FlowId, IdempotencyKey, Receipt, RunId, RunSummary, SignalPayload } from "./ControlSchema.ts"

/**
 * Opaque request data passed to a channel before decoding.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RawInbound {
  readonly body: Uint8Array
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly idempotencyKey: IdempotencyKey
}

/**
 * The channel mapping after a verified payload has been decoded.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type InboundResult =
  | { readonly _tag: "Start"; readonly flowId: FlowId; readonly input: unknown }
  | { readonly _tag: "Signal"; readonly runId: RunId; readonly signal: SignalPayload }

/**
 * A persisted per-channel delivery record. `messageId` identifies an existing
 * platform message, so a reconnect can update it instead of posting again.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Delivery {
  readonly cursor: string
  readonly messageId?: string | undefined
}

/**
 * A side-effect-free outbound projection. Network delivery belongs to the
 * transport adapter, which consumes this value after it is journaled.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface DeliveryProjection {
  readonly cursor: string
  readonly messageId?: string | undefined
  readonly operation: "post" | "edit" | "noop"
  readonly message: unknown
}

/**
 * A bidirectional platform adapter.
 *
 * `verify` must only inspect opaque bytes and headers. It always precedes
 * `decode`, preventing untrusted public requests from reaching planning.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Channel<A = unknown> {
  readonly name: string
  readonly schema: Schema.Schema<A>
  readonly verify: (raw: RawInbound) => Effect.Effect<void, Unauthorized>
  readonly decode: (raw: RawInbound) => Effect.Effect<A, InvalidInput>
  readonly map: (payload: A) => Effect.Effect<InboundResult, InvalidInput>
  readonly project: (run: RunSummary, delivery: Delivery | undefined) => DeliveryProjection
}

/**
 * Arguments for ingesting one authenticated channel request.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface IngestRequest {
  readonly channel: string
  readonly raw: RawInbound
}

/**
 * Arguments for projecting one run onto a channel.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ProjectRequest {
  readonly channel: string
  readonly run: RunSummary
}

/**
 * The channel coordinator.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Channels {
  readonly register: (channel: Channel) => Effect.Effect<void>
  readonly lookup: (name: string) => Effect.Effect<Channel, Unavailable>
  readonly ingest: (request: IngestRequest) => Effect.Effect<Receipt, ControlError>
  readonly project: (request: ProjectRequest) => Effect.Effect<DeliveryProjection, Unavailable>
}

/**
 * Service tag for channel registration, ingestion, and pure projection.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const Channels: Context.Service<Channels, Channels> = Context.Service("/control/Channels")

const unavailable = (feature: string): Unavailable =>
  new Unavailable({
    feature,
    ticket: "control-channel-registry"
  })

const deliveryKey = (channel: string, run: RunSummary): string =>
  `${channel}:${String((run as { readonly runId?: unknown }).runId)}`

/**
 * Builds an in-memory channel registry and journal-shaped delivery map.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = Effect.gen(function*() {
  const channels = yield* Ref.make(new Map<string, Channel>())
  const deliveries = yield* Ref.make(new Map<string, Delivery>())
  const applied = yield* Ref.make(new Set<string>())
  const ingestion = yield* Semaphore.make(1)
  const control = yield* Control

  const lookup = Effect.fn("Channels.lookup")(function*(name: string): Effect.fn.Return<Channel, Unavailable> {
    return yield* Effect.flatMap(Ref.get(channels), (registered) => {
      const channel = registered.get(name)
      return channel === undefined
        ? Effect.fail(unavailable(`channel "${name}" is not registered`))
        : Effect.succeed(channel)
    })
  })

  return Channels.of({
    register: Effect.fn("Channels.register")((channel) =>
      Ref.update(channels, (registered) => {
        const next = new Map(registered)
        next.set(channel.name, channel)
        return next
      })
    ),
    lookup,
    ingest: Effect.fn("Channels.ingest")((request) =>
      ingestion.withPermits(1)(Effect.gen(function*() {
        const channel = yield* lookup(request.channel)
        // This ordering is intentional: signature verification is the
        // amplification guard and must happen before decode or Control access.
        yield* channel.verify(request.raw)
        const payload = yield* channel.decode(request.raw)
        const mapped = yield* channel.map(payload)
        const key = String(request.raw.idempotencyKey)
        const replay = yield* Ref.get(applied).pipe(Effect.map((keys) => keys.has(key)))
        if (replay) return { _tag: "AlreadyApplied", receiptId: String(request.raw.idempotencyKey) }
        let receipt: Receipt
        if (mapped._tag === "Signal") {
          receipt = yield* control.signal({
            runId: mapped.runId,
            signal: mapped.signal,
            idempotencyKey: request.raw.idempotencyKey
          })
        } else {
          const plan = yield* control.plan({
            flowId: mapped.flowId,
            input: mapped.input,
            idempotencyKey: request.raw.idempotencyKey
          })
          receipt = yield* control.run({
            _tag: "Plan",
            planId: plan.planId,
            digest: plan.digest,
            envelope: plan.envelope,
            idempotencyKey: request.raw.idempotencyKey
          })
        }
        yield* Ref.update(applied, (keys) => {
          const next = new Set(keys)
          next.add(key)
          return next
        })
        return receipt
      }))
    ),
    project: Effect.fn("Channels.project")(function*(request) {
      const channel = yield* lookup(request.channel)
      const key = deliveryKey(request.channel, request.run)
      const prior = yield* Ref.get(deliveries).pipe(Effect.map((map) => map.get(key)))
      const projection = channel.project(request.run, prior)
      yield* Ref.update(deliveries, (current) => {
        const next = new Map(current)
        next.set(key, { cursor: projection.cursor, messageId: projection.messageId })
        return next
      })
      return projection
    })
  })
})

/**
 * In-memory channel layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = Layer.effect(Channels, make)
