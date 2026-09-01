/**
 * Channel contracts and the in-memory channel coordinator.
 *
 * A channel verifies opaque transport data before it decodes or maps it. The
 * resulting request is then dispatched through the Control service; channels
 * do not acquire an execution path of their own.
 *
 * @since 0.1.0
 */
import * as Sha256 from "@smthrs/crypto/Sha256"
import { Context, Effect, Layer, Ref, type Schema, Semaphore } from "effect"
import { Control } from "./Control.ts"
import { type ControlError, type InvalidInput, type Unauthorized, Unavailable } from "./ControlError.ts"
import { ControlRuntime } from "./ControlRuntime.ts"
import type { FlowId, IdempotencyKey, Receipt, RunId, RunSummary, SignalPayload } from "./ControlSchema.ts"
import { alreadyApplied } from "./internal/planning.ts"

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
  /** Deterministic, side-effect-free decoding; retries may evaluate it again. */
  readonly decode: (raw: RawInbound) => Effect.Effect<A, InvalidInput>
  /** Deterministic, side-effect-free mapping; retries may evaluate it again. */
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

/** Collision-free control-plane key for one channel-owned external key. */
const scopedKey = (channel: string, key: IdempotencyKey): IdempotencyKey =>
  `channel:${channel.length}:${channel}:${key}`

const mutationKey = (channel: string, key: IdempotencyKey): IdempotencyKey =>
  `channel.ingest:${scopedKey(channel, key)}`

/** The body digest is durable comparison data; headers may contain secrets. */
const fingerprint = (body: Uint8Array): string => `channel-ingress:v1:${Sha256.digestSync(body)}`

const externalReceipt = (receipt: Receipt, key: IdempotencyKey): Receipt => {
  switch (receipt._tag) {
    case "Accepted":
    case "AlreadyApplied":
    case "Parked":
      return { ...receipt, receiptId: key }
    default:
      return receipt
  }
}

/**
 * Builds an in-memory channel registry and delivery map over Control's durable
 * mutation store. Inbound idempotency therefore survives coordinator restarts;
 * only registration and outbound projection cursors are process-local.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
interface InboundReceiptStore {
  readonly lookupMutation: (
    key: IdempotencyKey,
    fingerprint: string
  ) => Effect.Effect<Receipt | undefined, ControlError>
  readonly recordMutation: (
    key: IdempotencyKey,
    fingerprint: string,
    receipt: Receipt
  ) => Effect.Effect<void, ControlError>
}

const makeWith = (runtime: InboundReceiptStore) =>
  Effect.gen(function*() {
    const channels = yield* Ref.make(new Map<string, Channel>())
    const deliveries = yield* Ref.make(new Map<string, Delivery>())
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
          const externalKey = request.raw.idempotencyKey
          const durableKey = mutationKey(request.channel, externalKey)
          const bodyFingerprint = fingerprint(request.raw.body)
          const prior = yield* runtime.lookupMutation(durableKey, bodyFingerprint)
          if (prior !== undefined) return externalReceipt(prior, externalKey)

          const payload = yield* channel.decode(request.raw)
          const mapped = yield* channel.map(payload)
          const key = scopedKey(request.channel, externalKey)
          let receipt: Receipt
          if (mapped._tag === "Signal") {
            receipt = yield* control.signal({
              runId: mapped.runId,
              signal: mapped.signal,
              idempotencyKey: key
            })
          } else {
            const plan = yield* control.plan({
              flowId: mapped.flowId,
              input: mapped.input,
              idempotencyKey: key
            })
            receipt = yield* control.run({
              _tag: "Plan",
              planId: plan.planId,
              digest: plan.digest,
              envelope: plan.envelope,
              idempotencyKey: key
            })
          }
          if (receipt._tag !== "Conflict") {
            yield* runtime.recordMutation(durableKey, bodyFingerprint, receipt)
          }
          return externalReceipt(receipt, externalKey)
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
 * Builds the coordinator over Control's durable mutation store.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  return yield* makeWith(runtime)
})

/**
 * Builds a process-local coordinator for adapter unit tests.
 *
 * Production hosts use {@link layer}; this constructor deliberately makes no
 * restart guarantee.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeMemory = Effect.gen(function*() {
  const records = yield* Ref.make(
    new Map<IdempotencyKey, {
      readonly fingerprint: string
      readonly receipt: Receipt
    }>()
  )
  return yield* makeWith({
    lookupMutation: (key, candidate) =>
      Ref.get(records).pipe(Effect.map((stored) => {
        const prior = stored.get(key)
        if (prior === undefined) return undefined
        return prior.fingerprint === candidate
          ? alreadyApplied(key, prior.receipt)
          : { _tag: "Conflict", message: `idempotency key ${key} was used for another mutation` }
      })),
    recordMutation: (key, candidate, receipt) =>
      Ref.update(records, (stored) => {
        const next = new Map(stored)
        next.set(key, { fingerprint: candidate, receipt })
        return next
      })
  })
})

/**
 * Channel layer with durable inbound receipts supplied by `ControlRuntime`.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = Layer.effect(Channels, make)

/**
 * Process-local channel layer for adapter unit tests only.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemory: Layer.Layer<Channels, never, Control> = Layer.effect(Channels, makeMemory)
