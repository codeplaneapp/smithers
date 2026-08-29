/**
 * Webhook ingress as library code, bound to the control plane.
 *
 * Smithers 1.0 has no `listeners` verb and no gateway-level webhook
 * configuration. A webhook door is a `@smthrs/control` `Channel` an
 * application registers with `Channels`, and `Channels.ingest` runs the fixed
 * order that matters: verify the raw bytes, then decode, then map, then reach
 * `Control`. Signature verification is the amplification guard, so nothing in
 * this module lets a provider decoder run before it.
 *
 * `Channels.ingest` also drops a replayed `idempotencyKey`, which is what
 * makes a provider redelivery safe to accept.
 *
 * @since 1.0.0
 */
import type { Channel, InboundResult, RawInbound } from "@smthrs/control/Channels"
import { InvalidInput, Unauthorized } from "@smthrs/control/ControlError"
import type { FlowId, RunId, RunSummary } from "@smthrs/control/ControlSchema"
import type { Credential, CredentialRef } from "@smthrs/control/Credential"
import * as WebhookChannel from "@smthrs/control/WebhookChannel"
import { Effect, Redacted, Schema } from "effect"
import type { ExternalEvent } from "./ExternalEvent.ts"
import { IntegrationError, isIntegrationError, toInvalidInput, toUnauthorized } from "./IntegrationError.ts"
import * as SignalName from "./SignalName.ts"

/**
 * How a channel obtains the signing secret behind a credential reference.
 *
 * Resolution is a host concern: the reference is journal-safe, the secret is
 * not, and only the host knows where it lives.
 *
 * @category models
 * @since 1.0.0
 */
export type SecretResolver = (
  credential: Redacted.Redacted<CredentialRef>
) => Effect.Effect<Redacted.Redacted<string>, Unauthorized>

/**
 * A resolver that always answers with one secret. For a single-tenant
 * deployment that reads its webhook secret from the environment.
 *
 * @category constructors
 * @since 1.0.0
 */
export const constantSecret = (secret: Redacted.Redacted<string>): SecretResolver => () => Effect.succeed(secret)

/**
 * A resolver backed by the control plane's credential store.
 *
 * Takes the resolved service rather than requiring it, because a channel's
 * verifier runs with no environment of its own.
 *
 * @category constructors
 * @since 1.0.0
 */
export const credentialSecret = (credentials: Credential): SecretResolver => (credential) =>
  credentials.resolve(Redacted.value(credential)).pipe(
    Effect.mapError((error) =>
      error._tag === "/control/Unauthorized"
        ? error
        : new Unauthorized({ message: `credential ${Redacted.value(credential).name} is unavailable` })
    )
  )

/**
 * What a provider supplies to get a control-plane channel.
 *
 * @category models
 * @since 1.0.0
 */
export interface Config {
  /** The name `Channels.register` and `Channels.ingest` address it by. */
  readonly name: string
  /** The journal-safe reference to the signing secret. */
  readonly credential: Redacted.Redacted<CredentialRef>
  readonly secret: SecretResolver
  /** The provider's signature check over the exact delivered bytes. */
  readonly verify: (raw: RawInbound, secret: string) => boolean
  /**
   * The provider's decoder. Runs only after verification, and may throw an
   * `IntegrationError` for a delivery whose headers or body it cannot read.
   */
  readonly decode: (raw: RawInbound, payload: unknown) => ExternalEvent
  /** What the event does: start a flow, or signal a run. */
  readonly route: (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>
  /** The outbound projection. Defaults to `noop`, which posts nothing. */
  readonly project?: ((run: RunSummary, delivery: unknown) => ReturnType<Channel["project"]>) | undefined
}

const noProjection: Channel["project"] = (run) => ({
  cursor: String(run.updatedAt),
  operation: "noop",
  message: null
})

const invalidSignature = (name: string): IntegrationError =>
  new IntegrationError("invalid-signature", `${name} webhook signature did not verify.`, { channel: name })

/**
 * Builds the control-plane channel for one provider webhook.
 *
 * The verifier is a `WebhookChannel` signature verifier: it sees the raw bytes
 * and the credential reference, and nothing else. A delivery whose signature
 * does not match fails with `Unauthorized` before the provider decoder or
 * `Control` is reached.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (config: Config): Channel => {
  const verifier: WebhookChannel.SignatureVerifier = (raw, credential) =>
    config.secret(credential).pipe(
      Effect.flatMap((secret) =>
        config.verify(raw, Redacted.value(secret))
          ? Effect.void
          : Effect.fail(toUnauthorized(invalidSignature(config.name)))
      )
    )
  const json = WebhookChannel.make({
    name: config.name,
    schema: Schema.Json,
    credential: config.credential,
    verify: verifier,
    map: () => Effect.fail(new InvalidInput({ issue: "unreachable: the provider decoder maps the event" })),
    project: config.project ?? noProjection
  })
  return {
    name: config.name,
    schema: Schema.Unknown,
    verify: json.verify,
    decode: (raw) =>
      json.decode(raw).pipe(
        Effect.flatMap((payload) =>
          Effect.try({
            try: () => config.decode(raw, payload),
            catch: (cause) =>
              isIntegrationError(cause) ? toInvalidInput(cause) : new InvalidInput({ issue: String(cause) })
          })
        )
      ),
    map: (event) => config.route(event as ExternalEvent),
    project: json.project
  }
}

/**
 * A route that starts `flowId` with the event as its input.
 *
 * @category constructors
 * @since 1.0.0
 */
export const startFlow = (flowId: FlowId) => (event: ExternalEvent): Effect.Effect<InboundResult, InvalidInput> =>
  Effect.succeed({ _tag: "Start", flowId, input: event })

/**
 * A route that signals `runId` with the event's signal name and payload.
 *
 * @category constructors
 * @since 1.0.0
 */
export const signalRun = (runId: RunId) => (event: ExternalEvent): Effect.Effect<InboundResult, InvalidInput> =>
  Effect.succeed({ _tag: "Signal", runId, signal: SignalName.toSignalPayload(event) })
