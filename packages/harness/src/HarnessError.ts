/**
 * Stable failures reported at the harness translation boundary.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Stable harness failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const HarnessErrorCode = Schema.Literals([
  "assembly_failed",
  "render_failed",
  "projection_failed",
  "model_failed",
  "elaboration_failed",
  "engine_failed",
  "invalid_step",
  "read_only_cap",
  "lazy_tool_prompt_metadata",
  "aborted",
  "suspended",
  "adapter_spawn_failed",
  "adapter_quota_exhausted",
  "adapter_session_lost",
  "adapter_config_invalid",
  "adapter_auth_failed",
  "adapter_protocol_error",
  "adapter_binary_missing",
  "adapter_unsupported",
  "adapter_structured_output_failed",
  "unknown"
])

/**
 * Stable harness failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type HarnessErrorCode = typeof HarnessErrorCode.Type

/**
 * A failure while translating a recorded agent turn.
 *
 * `cause` is {@link Schema.Defect} rather than {@link Schema.Unknown}: a
 * `HarnessError` is a member of `@smthrs/agent/AgentAction`'s `AgentFailure`
 * union, which is encoded through the durable exit schema for journaling. A
 * raw `Error` (or any other non-JSON value) attached as `cause` has no safe
 * JSON representation under `Schema.Unknown`, so encoding it dies with a
 * `SchemaError` that replaces the real failure instead of reporting it.
 * `Schema.Defect` decodes to the same `unknown` type but encodes any value —
 * including a real `Error` — to JSON, with the same graceful degradation
 * `Cause` defects already rely on elsewhere in this codebase.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class HarnessError extends Schema.TaggedError<HarnessError>()("/harness/HarnessError", {
  code: HarnessErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
