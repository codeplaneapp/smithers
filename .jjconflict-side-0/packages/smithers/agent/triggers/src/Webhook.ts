/**
 * Verified webhook ingestion through the authoritative Control boundary.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 * @since 0.1.0
 */
import * as ControlChannels from "@smthrs/control/Channels"
import type { ControlError } from "@smthrs/control/ControlError"
import { InvalidInput, Unauthorized } from "@smthrs/control/ControlError"
import type { Receipt, RunSummary } from "@smthrs/control/ControlSchema"
import type { CredentialRef } from "@smthrs/control/Credential"
import * as ControlWebhook from "@smthrs/control/WebhookChannel"
import { Effect, type Redacted, Schema } from "effect"
import type * as Channel from "./Channel.ts"
import { TriggerError } from "./TriggerError.ts"

/**
 * Compares a supplied byte string against the expected one without returning
 * early on a mismatch.
 *
 * The loop runs exactly `expected.length` times, so its iteration count is
 * fixed by the secret side of the comparison and never by the caller's. Reading
 * the longer of the two instead let a caller lengthen its input until the work
 * stopped growing, which reports the expected signature's length. The length
 * difference is folded into the result, so inputs of unequal length always
 * disagree.
 *
 * @category verification
 * @since 0.1.0
 */
export const constantTimeEqual = (expected: Uint8Array, supplied: Uint8Array): boolean => {
  let difference = expected.length ^ supplied.length
  for (const [index, byte] of expected.entries()) {
    difference |= byte ^ (supplied[index] ?? 0)
  }
  return difference === 0
}

/**
 * Configuration for a raw-byte signature verifier.
 *
 * `expected` receives a private copy of the request bytes and the redacted
 * credential reference the channel was declared with, and answers with the
 * signature bytes the request must carry in `header`. It returns an Effect so
 * the secret is resolved through the host's resolver per request rather than
 * captured in a closure at declaration time, and so a resolution or HMAC
 * failure arrives as a typed `verification_failed` instead of a defect that
 * kills the fiber.
 *
 * @category models
 * @since 0.1.0
 */
export interface SignatureConfig {
  readonly header: string
  readonly expected: (
    body: Uint8Array,
    credential: Redacted.Redacted<CredentialRef>
  ) => Effect.Effect<Uint8Array, TriggerError>
}

/**
 * Builds a verifier that compares a signature header in constant time.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeSignatureVerifier = (config: SignatureConfig): Channel.Verify => (raw, credential) =>
  Effect.suspend(() => {
    const supplied = raw.headers[config.header.toLowerCase()] ?? raw.headers[config.header]
    const actual = supplied === undefined ? new Uint8Array() : new TextEncoder().encode(supplied)
    // The verifier gets its own copy: nothing it does to these bytes can reach
    // the buffer that is about to be fingerprinted and decoded.
    return config.expected(raw.body.slice(), credential).pipe(
      Effect.flatMap((expected) =>
        constantTimeEqual(expected, actual)
          ? Effect.void
          : Effect.fail(
            new TriggerError({
              code: "verification_failed",
              message: `webhook signature in ${config.header} did not verify`
            })
          )
      )
    )
  })

/**
 * Webhook declaration configuration.
 *
 * `credential` is required. It used to default to a reference named after the
 * channel, so a webhook declared without one verified against whatever
 * credential happened to share its name instead of being refused, and two
 * declarations differing only in credential verified identically.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config<Payload, Outbound = never> extends Channel.Config<Payload, RunSummary, Outbound> {
  readonly credential: Redacted.Redacted<CredentialRef>
}

/**
 * A webhook door that can only ingest through `Channels` and `Control`.
 *
 * @category services
 * @since 0.1.0
 */
export interface Webhook {
  readonly name: string
  readonly register: Effect.Effect<void, never, ControlChannels.Channels>
  readonly ingest: (
    raw: Channel.RawInbound
  ) => Effect.Effect<Receipt, ControlError | TriggerError, ControlChannels.Channels>
}

const invalidInput = (issue: string): InvalidInput => new InvalidInput({ issue })

const toControlChannel = <Payload, Outbound>(
  config: Config<Payload, Outbound>
): ControlChannels.Channel => {
  const channel = ControlWebhook.make({
    name: config.name,
    schema: config.schema,
    credential: config.credential,
    verify: (raw, credential) =>
      config.verify(raw, credential).pipe(
        Effect.mapError((error) => new Unauthorized({ message: error.message }))
      ),
    map: (payload) => {
      const inbound = config.inbound(payload)
      if ("start" in inbound) {
        return Effect.succeed({
          _tag: "Start" as const,
          flowId: inbound.start.flowId,
          input: inbound.start.input
        })
      }
      return Schema.decodeUnknownEffect(Schema.Json)(inbound.signal.value).pipe(
        Effect.map(
          (value) => ({
            _tag: "Signal" as const,
            runId: inbound.signal.runId,
            signal: {
              name: inbound.signal.stepId,
              payload: value
            }
          })
        ),
        Effect.mapError((error) => invalidInput(String(error)))
      )
    },
    project: (run) => {
      if (config.outbound === undefined) {
        return {
          cursor: String(run.updatedAt),
          operation: "noop" as const,
          message: null
        }
      }
      return {
        cursor: String(run.updatedAt),
        operation: "post" as const,
        message: config.outbound(run)
      }
    }
  })
  return {
    ...channel,
    // The record keeps the declared schema. Overwriting it with
    // `Schema.Unknown` left the registry advertising a schema that its own
    // `decode` closure, which closed over the real one, disagreed with. Only
    // `map` needs a cast: `ControlChannels.Channel<unknown>` hands it an
    // `unknown` payload that `decode` has already produced as a `Payload`.
    schema: channel.schema,
    map: (payload) => channel.map(payload as Payload)
  }
}

/**
 * Builds a webhook door whose only dispatch path is the Control channel
 * coordinator.
 *
 * Verification occurs inside `Channels.ingest` before the adapter's JSON or
 * schema decoder and before any Control operation.
 *
 * `ingest` does not register: a channel is registered once, deliberately,
 * through {@link Webhook.register}, so traffic to an unregistered channel is
 * reported as unavailable rather than silently self-registering the door it
 * arrived at.
 *
 * `ingest` also copies `body`, `headers`, and `idempotencyKey` before anything
 * reads them. Verification, delivery fingerprinting, and decoding then all see
 * one private snapshot, so a verifier that edits the bytes it was handed, or a
 * caller that mutates its own object between building this Effect and running
 * it, cannot authenticate one payload and have another decoded. A
 * `SharedArrayBuffer`-backed view is copied out of shared memory by the same
 * step.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <Payload, Outbound = never>(
  config: Config<Payload, Outbound>
): Webhook => {
  const channel = toControlChannel(config)
  const register = Effect.flatMap(ControlChannels.Channels, (channels) => channels.register(channel))
  return {
    name: config.name,
    register,
    ingest: (raw) => {
      // Copied here rather than inside the Effect: the copy has to happen when
      // the caller hands the request over, not when the returned Effect
      // eventually runs, or a caller that reuses its own buffer in between
      // changes what gets authenticated.
      const snapshot: Channel.RawInbound = {
        body: raw.body.slice(),
        headers: { ...raw.headers },
        idempotencyKey: raw.idempotencyKey
      }
      return Effect.gen(function*() {
        const channels = yield* ControlChannels.Channels
        return yield* channels.ingest({ channel: config.name, raw: snapshot })
      }).pipe(
        Effect.mapError((error) =>
          error instanceof Unauthorized
            ? new TriggerError({
              code: "verification_failed",
              message: error.message,
              cause: error
            })
            : error
        )
      )
    }
  }
}
