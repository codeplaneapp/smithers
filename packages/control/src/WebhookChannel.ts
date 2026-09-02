/**
 * Webhook channel construction over Effect's transport-neutral HTTP request.
 *
 * @since 0.1.0
 */
import { Effect, type Redacted, Schema } from "effect"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { type Channel, Channels, type InboundResult, type RawInbound } from "./Channels.ts"
import { InvalidInput, type Unauthorized } from "./ControlError.ts"
import type { IdempotencyKey } from "./ControlSchema.ts"
import type { CredentialRef } from "./Credential.ts"

/**
 * Signature verifier injected by a webhook transport.
 *
 * The credential is intentionally a redacted reference. Resolution belongs at
 * the host adapter boundary, never in webhook input or its persisted record.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SignatureVerifier = (
  raw: RawInbound,
  credential: Redacted.Redacted<CredentialRef>
) => Effect.Effect<void, Unauthorized>

/**
 * Configuration for a schema-declared webhook channel.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Config<A> {
  readonly name: string
  readonly schema: Schema.Schema<A>
  readonly credential: Redacted.Redacted<CredentialRef>
  readonly fingerprintHeaders?: Channel<A>["fingerprintHeaders"]
  readonly verify: SignatureVerifier
  readonly map: (payload: A) => Effect.Effect<InboundResult, InvalidInput>
  readonly project: Channel<A>["project"]
}

const invalidInput = (issue: string): InvalidInput => new InvalidInput({ issue })

/**
 * Builds a webhook channel. Verification receives raw bytes and headers before
 * JSON parsing and schema decoding.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = <A>(config: Config<A>): Channel<A> => {
  const decode = Schema.decodeUnknownEffect(config.schema)
  return {
    name: config.name,
    schema: config.schema,
    ...(config.fingerprintHeaders === undefined ? {} : { fingerprintHeaders: config.fingerprintHeaders }),
    verify: Effect.fn("WebhookChannel.verify")((raw) => config.verify(raw, config.credential)),
    decode: Effect.fn("WebhookChannel.decode")((raw) =>
      Effect.try({
        try: () => JSON.parse(new TextDecoder().decode(raw.body)),
        catch: (cause) => invalidInput(`invalid webhook JSON: ${String(cause)}`)
      }).pipe(
        Effect.flatMap((json) => decode(json)),
        Effect.mapError((cause) => cause instanceof InvalidInput ? cause : invalidInput(String(cause)))
      ) as Effect.Effect<A, InvalidInput>
    ),
    map: Effect.fn("WebhookChannel.map")((payload) => config.map(payload)),
    project: config.project
  }
}

/**
 * Reads an abstract Effect HTTP request and dispatches it through Channels.
 * This is mountable by any Effect HTTP host; it contains no Node transport
 * dependencies.
 *
 * @category handlers
 * @since 0.1.0
 * @slop
 */
export const handler = (
  channel: string,
  idempotencyKey: IdempotencyKey
) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = new Uint8Array(yield* request.arrayBuffer)
    const channels = yield* Channels
    return yield* channels.ingest({
      channel,
      raw: { body, headers: request.headers, idempotencyKey }
    })
  })
