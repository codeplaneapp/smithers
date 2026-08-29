/**
 * GitHub webhook ingress.
 *
 * A delivery is verified against `X-Hub-Signature-256` before anything reads
 * its body, then decoded into one {@link ExternalEvent}. The event's name and
 * correlation are the most specific forms the payload supports, and
 * {@link names} and {@link correlations} expose the full ordered ladder for a
 * caller that routes on a broader form.
 *
 * Smithers 0.x fanned one delivery out into every (name, correlation) pair,
 * because its delivery pipeline broadcast to any run parked on an exact match.
 * 1.0 has no broadcast: a channel starts a flow or signals an addressed run,
 * so a delivery decodes to one event and the ladder is a routing input rather
 * than a set of duplicate signals.
 *
 * @since 1.0.0
 */
import type { Channel, InboundResult, RawInbound } from "@smthrs/control/Channels"
import type { InvalidInput } from "@smthrs/control/ControlError"
import type { CredentialRef } from "@smthrs/control/Credential"
import type { Effect, Redacted } from "effect"
import * as Core from "../core/Channel.ts"
import type { ExternalEvent } from "../core/ExternalEvent.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import { readHeader, readInteger, readString } from "../core/JsonPath.ts"
import * as SignalName from "../core/SignalName.ts"
import { GITHUB_SIGNATURE_PREFIX, verifySignature } from "../core/Signature.ts"

/**
 * The service segment of every GitHub signal name.
 *
 * @category constants
 * @since 1.0.0
 */
export const SERVICE = "github"

/**
 * Whether the delivery's `X-Hub-Signature-256` matches `secret`.
 *
 * The signature covers the exact delivered bytes, so this reads the raw body
 * and never a re-serialized copy of the parsed JSON.
 *
 * @category verification
 * @since 1.0.0
 */
export const verify = (raw: RawInbound, secret: string): boolean =>
  verifySignature({
    payload: raw.body,
    secret,
    signature: readHeader(raw, "x-hub-signature-256"),
    prefix: GITHUB_SIGNATURE_PREFIX
  })

/**
 * The signal names a delivery answers to, most specific first.
 *
 * A payload carrying an `action` adds the per-action variant
 * (`integration:github:pull_request.opened`) ahead of the bare event name.
 *
 * @category getters
 * @since 1.0.0
 */
export const names = (event: string, payload: unknown): ReadonlyArray<string> => {
  const action = readString(payload, "action")
  const base = SignalName.eventName(SERVICE, event)
  return action === undefined ? [base] : [SignalName.eventName(SERVICE, `${event}.${action}`), base]
}

/**
 * The correlations a delivery answers to, most specific first:
 * `owner/repo#number`, `owner/repo`, then `null` for a repository-agnostic
 * listener.
 *
 * Pull requests, issues, and issue comments each carry the entity number in a
 * different place, which is why all three are read.
 *
 * @category getters
 * @since 1.0.0
 */
export const correlations = (payload: unknown): ReadonlyArray<string | null> => {
  const fullName = readString(payload, "repository.full_name")
  const repo = fullName !== undefined && fullName.includes("/") ? fullName : undefined
  const number = readInteger(payload, "pull_request.number") ?? readInteger(payload, "issue.number") ??
    readInteger(payload, "number")
  const found: Array<string | null> = []
  if (repo !== undefined && number !== undefined) found.push(`${repo}#${number}`)
  if (repo !== undefined) found.push(repo)
  found.push(null)
  return found
}

/**
 * Decodes one verified delivery.
 *
 * Throws an `IntegrationError` when GitHub's own headers are missing: without
 * `X-GitHub-Event` there is no signal name, and without `X-GitHub-Delivery`
 * there is no redelivery identity.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decode = (raw: RawInbound, payload: unknown, receivedAtMs: number = Date.now()): ExternalEvent => {
  const event = readHeader(raw, "x-github-event")
  if (event === undefined || event.length === 0) {
    throw new IntegrationError("decode-failed", "GitHub webhook is missing the X-GitHub-Event header.", {
      source: SERVICE
    })
  }
  const deliveryId = readHeader(raw, "x-github-delivery")
  if (deliveryId === undefined || deliveryId.length === 0) {
    throw new IntegrationError("decode-failed", "GitHub webhook is missing the X-GitHub-Delivery header.", {
      source: SERVICE,
      event
    })
  }
  const eventName = names(event, payload)[0] as string
  const correlationId = correlations(payload)[0] as string | null
  return {
    source: SERVICE,
    eventName,
    correlationId,
    payload: payload as ExternalEvent["payload"],
    dedupeKey: `${deliveryId}:${eventName}:${correlationId ?? "*"}`,
    receivedAtMs
  }
}

/**
 * What {@link channel} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface ChannelOptions {
  /** The channel name. Defaults to `github`. */
  readonly name?: string | undefined
  readonly credential: Redacted.Redacted<CredentialRef>
  readonly secret: Core.SecretResolver
  readonly route: (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>
  readonly project?: Core.Config["project"]
}

/**
 * A control-plane channel for GitHub webhooks.
 *
 * @category constructors
 * @since 1.0.0
 */
export const channel = (options: ChannelOptions): Channel =>
  Core.make({
    name: options.name ?? SERVICE,
    credential: options.credential,
    secret: options.secret,
    verify,
    decode: (raw, payload) => decode(raw, payload),
    route: options.route,
    project: options.project
  })
