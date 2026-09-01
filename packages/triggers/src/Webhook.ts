/**
 * Verified webhook ingestion through the authoritative Control boundary.
 *
 * @see packages/triggers/docs/api.md
 * @since 0.1.0
 */
import * as ControlChannels from "@smthrs/control/Channels"
import type { ControlError } from "@smthrs/control/ControlError"
import { InvalidInput, Unauthorized } from "@smthrs/control/ControlError"
import type { Receipt, RunSummary } from "@smthrs/control/ControlSchema"
import type { CredentialRef } from "@smthrs/control/Credential"
import * as ControlWebhook from "@smthrs/control/WebhookChannel"
import { Effect, Redacted, Schema } from "effect"
import type * as Channel from "./Channel.ts"
import { TriggerError } from "./TriggerError.ts"

/**
 * Compares two byte strings without returning early on a mismatch.
 *
 * The loop always examines the longest supplied input and incorporates the
 * length difference into the result.
 *
 * @category verification
 * @since 0.1.0
 */
export const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

/**
 * Configuration for a raw-byte signature verifier.
 *
 * `expected` receives the original request bytes. It must return the signature
 * bytes expected in `header`.
 *
 * @category models
 * @since 0.1.0
 */
export interface SignatureConfig {
  readonly header: string
  readonly expected: (body: Uint8Array) => Uint8Array
}

/**
 * Builds a verifier that compares a signature header in constant time.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeSignatureVerifier = (config: SignatureConfig): Channel.Verify => (raw) =>
  Effect.suspend(() => {
    const supplied = raw.headers[config.header.toLowerCase()] ?? raw.headers[config.header]
    const expected = config.expected(raw.body)
    const actual = supplied === undefined ? new Uint8Array() : new TextEncoder().encode(supplied)
    return constantTimeEqual(expected, actual)
      ? Effect.void
      : Effect.fail(
        new TriggerError({
          code: "verification_failed",
          message: `webhook signature in ${config.header} did not verify`
        })
      )
  })

/**
 * Webhook declaration configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config<Payload, Outbound = never> extends Channel.Config<Payload, RunSummary, Outbound> {
  readonly credential?: Redacted.Redacted<CredentialRef> | undefined
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
    credential: config.credential ?? Redacted.make({ id: config.name, name: config.name }),
    verify: (raw) =>
      config.verify(raw).pipe(
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
    schema: Schema.Unknown,
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
    ingest: (raw) =>
      Effect.gen(function*() {
        const channels = yield* ControlChannels.Channels
        yield* channels.register(channel)
        return yield* channels.ingest({ channel: config.name, raw })
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
