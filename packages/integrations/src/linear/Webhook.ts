/**
 * Linear webhook ingress.
 *
 * Linear signs the raw body with HMAC-SHA256 and sends the bare hex digest in
 * `Linear-Signature`. Verification also checks `webhookTimestamp` inside the
 * body: a valid signature stays valid forever, so without a freshness window a
 * captured delivery could be replayed indefinitely.
 *
 * @since 1.0.0
 */
import type { Channel, InboundResult, RawInbound } from "@smthrs/control/Channels"
import type { InvalidInput } from "@smthrs/control/ControlError"
import type { CredentialRef } from "@smthrs/control/Credential"
import type { Effect, Redacted } from "effect"
import * as Core from "../core/Channel.ts"
import type { ExternalEvent } from "../core/ExternalEvent.ts"
import { readHeader, readJsonPath, readString } from "../core/JsonPath.ts"
import * as SignalName from "../core/SignalName.ts"
import { verifySignature } from "../core/Signature.ts"

/**
 * The service segment of every Linear signal name.
 *
 * @category constants
 * @since 1.0.0
 */
export const SERVICE = "linear"

/**
 * How stale a `webhookTimestamp` may be before the delivery is refused.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_TIMESTAMP_SKEW_MS = 60_000

/**
 * Linear's `webhookTimestamp` in milliseconds.
 *
 * Older payloads send seconds, so a value below the year-2001 millisecond
 * boundary is read as seconds.
 *
 * @category getters
 * @since 1.0.0
 */
export const timestampMs = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return value < 1e12 ? value * 1000 : value
}

/**
 * What {@link verify} allows.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifyOptions {
  readonly maxTimestampSkewMs?: number | undefined
  readonly nowMs?: number | undefined
}

/**
 * Whether the delivery's signature matches and its timestamp is fresh.
 *
 * @category verification
 * @since 1.0.0
 */
export const verify = (raw: RawInbound, secret: string, options: VerifyOptions = {}): boolean => {
  if (!verifySignature({ payload: raw.body, secret, signature: readHeader(raw, "linear-signature") })) return false
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(raw.body))
  } catch {
    return false
  }
  const sentAt = timestampMs(readJsonPath(payload, "webhookTimestamp"))
  if (sentAt === null) return false
  const skew = options.maxTimestampSkewMs ?? DEFAULT_TIMESTAMP_SKEW_MS
  return Math.abs((options.nowMs ?? Date.now()) - sentAt) <= skew
}

/**
 * The signal names a delivery answers to, most specific first:
 * `integration:linear:issue.update` then `integration:linear:issue`.
 *
 * @category getters
 * @since 1.0.0
 */
export const names = (payload: unknown): ReadonlyArray<string> => {
  const type = (readString(payload, "type") ?? "unknown").toLowerCase()
  const action = (readString(payload, "action") ?? "unknown").toLowerCase()
  return [SignalName.eventName(SERVICE, `${type}.${action}`), SignalName.eventName(SERVICE, type)]
}

/**
 * The correlations a delivery answers to, most specific first: the issue
 * identifier (`ENG-123`), the team key (`ENG`), then `null`.
 *
 * A comment delivery carries the issue one level down, under `data.issue`,
 * which is why both paths are read.
 *
 * @category getters
 * @since 1.0.0
 */
export const correlations = (payload: unknown): ReadonlyArray<string | null> => {
  const identifier = readString(payload, "data.identifier") ?? readString(payload, "data.issue.identifier")
  const teamKey = readString(payload, "data.team.key") ?? readString(payload, "data.issue.team.key")
  const found = [...new Set([identifier, teamKey].filter((value) => value !== undefined))] as Array<string | null>
  found.push(null)
  return found
}

/**
 * Decodes one verified delivery.
 *
 * Delivery identity is the `Linear-Delivery` header when present, and
 * otherwise the webhook id, entity, action, and timestamp, which together
 * identify the same delivery across a redelivery.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decode = (
  raw: RawInbound,
  payload: unknown,
  source: string = SERVICE,
  receivedAtMs: number = Date.now()
): ExternalEvent => {
  const type = (readString(payload, "type") ?? "unknown").toLowerCase()
  const action = (readString(payload, "action") ?? "unknown").toLowerCase()
  const deliveryId = readHeader(raw, "linear-delivery") ??
    [
      readString(payload, "webhookId") ?? "-",
      type,
      action,
      readString(payload, "data.id") ?? "-",
      String(readJsonPath(payload, "webhookTimestamp") ?? "-")
    ].join(":")
  const eventName = names(payload)[0] as string
  const correlationId = correlations(payload)[0] as string | null
  return {
    source,
    eventName,
    correlationId,
    payload: payload as ExternalEvent["payload"],
    dedupeKey: `${deliveryId}#${eventName}#${correlationId ?? ""}`,
    receivedAtMs
  }
}

/**
 * What {@link channel} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface ChannelOptions extends VerifyOptions {
  /** The channel name. Defaults to `linear`. */
  readonly name?: string | undefined
  readonly credential: Redacted.Redacted<CredentialRef>
  readonly secret: Core.SecretResolver
  readonly route: (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>
  readonly project?: Core.Config["project"]
}

/**
 * A control-plane channel for Linear webhooks.
 *
 * @category constructors
 * @since 1.0.0
 */
export const channel = (options: ChannelOptions): Channel => {
  const name = options.name ?? SERVICE
  return Core.make({
    name,
    credential: options.credential,
    secret: options.secret,
    verify: (raw, secret) =>
      verify(raw, secret, {
        maxTimestampSkewMs: options.maxTimestampSkewMs,
        nowMs: options.nowMs
      }),
    decode: (raw, payload) => decode(raw, payload, name),
    route: options.route,
    project: options.project
  })
}
