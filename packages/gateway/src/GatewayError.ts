/**
 * Typed failures surfaced by the workspace gateway.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Stable failure codes exposed by gateway operations.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export const GatewayErrorCode = Schema.Literals([
  "already_running",
  "not_running",
  "bind_failed",
  "unauthorized",
  "token_expired",
  "run_unavailable",
  "unsupported_projection",
  "subscription_expired",
  "overflow",
  "sweep_failed"
])

/**
 * A stable gateway failure code.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export type GatewayErrorCode = typeof GatewayErrorCode.Type

/**
 * A normalized gateway operation failure.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class GatewayError extends Schema.TaggedError<GatewayError>()("flows/gateway/GatewayError", {
  code: GatewayErrorCode,
  message: Schema.String,
  cause: Schema.Unknown
}) {}
