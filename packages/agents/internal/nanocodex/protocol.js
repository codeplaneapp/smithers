import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";

export const NANOCODEX_PROTOCOL_NAME = "smithers.nanocodex";
export const NANOCODEX_PROTOCOL_VERSION = 1;
export const NANOCODEX_BRIDGE_VERSION = "0.0.2";
export const NANOCODEX_VERSION = "0.5.0";
export const NANOCODEX_SHIPPED_TARGETS = Object.freeze(["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"]);
export const NANOCODEX_MODELS = Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
export const NANOCODEX_DEFAULT_MODEL = "gpt-5.6-sol";
export const NANOCODEX_THINKING_LEVELS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);
export const NANOCODEX_DEFAULT_THINKING = "high";
export const NANOCODEX_REASONING_MODES = Object.freeze(["standard", "pro"]);

/**
 * @param {unknown} value
 * @returns {"gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | undefined}
 */
export function normalizeNanocodexModel(value) {
  if (value === "gpt-5.6-sol" || value === "sol") return "gpt-5.6-sol";
  if (value === "gpt-5.6-terra" || value === "terra") return "gpt-5.6-terra";
  if (value === "gpt-5.6-luna" || value === "luna") return "gpt-5.6-luna";
  return undefined;
}

export const NANOCODEX_LIMITS = Object.freeze({
  maxInputRecordBytes: 25_165_824,
  maxOutputRecordBytes: 41_943_040,
  maxPromptBytes: 4_194_304,
  maxSnapshotBytes: 15_728_640,
  maxEventBytes: 1_048_576,
  maxEventTotalBytes: 16_777_216,
  maxStderrBytes: 65_536,
  maxCommandRecords: 256,
  maxJsonDepth: 64,
  maxJsonNodes: 262_144,
  maxJsonObjectMembers: 16_384,
  maxJsonArrayElements: 131_072,
  maxJsonStringBytes: 18_874_368,
  maxJsonKeyBytes: 1_024,
  maxManagedAuthFileBytes: 1_048_576,
});

const CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,127}$/;
const ERROR_CATEGORIES = new Set([
  "protocol",
  "config",
  "auth",
  "checkpoint",
  "workspace",
  "provider",
  "tool",
  "cleanup",
  "internal",
]);
const RETRY_DISPOSITIONS = new Set(["never", "safe", "after"]);
const THINKING_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const REASONING_MODES = new Set(["standard", "pro"]);
const TRUNCATION_REASONS = new Set([
  "event_limit",
  "aggregate_event_limit",
  "bridge_event_backpressure",
  "event_policy",
]);
const TERMINAL_TYPES = new Set(["turn.completed", "turn.failed", "turn.cancelled", "process.failed"]);
const PROJECTED_LIFECYCLE_EVENT_TYPES = new Set([
  "run.started",
  "run.steered",
  "run.error",
  "run.completed",
  "run.failed",
  "model.warmup.started",
  "model.warmup.completed",
  "model.warmup.failed",
  "model.call.started",
  "model.call.completed",
  "model.call.failed",
  "model.compaction.started",
  "model.compaction.completed",
  "model.compaction.failed",
  "model.attempt.started",
  "model.attempt.failed",
  "model.attempt.retrying",
  "model.connection.started",
  "model.connection.completed",
  "model.connection.failed",
]);
const ASSISTANT_PHASES = new Set(["commentary", "final_answer"]);
const TOOL_RESULT_STATUSES = new Set(["completed", "failed", "cancelled", "unknown"]);
const PROJECTED_TOOL_CALL_ID_MAX_BYTES = 256;
const PROJECTED_TOOL_NAME_MAX_BYTES = 128;
const EVENT_WIRE_ENVELOPE_RESERVE = 1_024;
const RUST_UNICODE_WHITESPACE_ONLY = /^\p{White_Space}*$/u;

/** A bounded validation error which never embeds rejected protocol data. */
export class NanocodexProtocolValidationError extends TypeError {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "NanocodexProtocolValidationError";
    this.code = code;
  }
}

/**
 * Parse one JSON value while rejecting duplicate object keys at every depth.
 * Native JSON.parse keeps the last duplicate, which is unsafe for correlated
 * protocol commands and capability negotiation.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseNanocodexJson(text) {
  try {
    scanJsonForDuplicateKeys(text);
  } catch (error) {
    if (error instanceof NanocodexProtocolValidationError) throw error;
    fail("invalid_json", "Nanocodex protocol JSON is invalid.");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("invalid_json", "Nanocodex protocol JSON is invalid.");
  }
  assertStrictJsonValue(value);
  return value;
}

/**
 * Validate either `smithers-nanocodex capabilities --json` output or the
 * identically-shaped `hello.data` value.
 *
 * @param {unknown} value
 * @returns {import("./protocol-types.ts").NanocodexCapabilities}
 */
export function validateNanocodexCapabilities(value) {
  assertExactObject(value, [
    "bridgeVersion",
    "target",
    "nanocodexVersion",
    "protocol",
    "checkpoint",
    "authenticationModes",
    "transportModes",
    "models",
    "defaultModel",
    "thinkingLevels",
    "defaultThinking",
    "reasoningModes",
    "features",
    "limits",
  ]);
  if (typeof value.bridgeVersion !== "string" || value.bridgeVersion.length === 0 || value.bridgeVersion.length > 128) {
    fail("bridge_version_mismatch", "Nanocodex protocol capability is incompatible.");
  }
  if (typeof value.target !== "string" || !NANOCODEX_SHIPPED_TARGETS.includes(value.target)) {
    fail("target_mismatch", "Nanocodex protocol capability is incompatible.");
  }
  assertLiteral(value.nanocodexVersion, NANOCODEX_VERSION, "nanocodex_version_mismatch");

  assertExactObject(value.protocol, ["name", "versions"]);
  assertLiteral(value.protocol.name, NANOCODEX_PROTOCOL_NAME, "protocol_name_mismatch");
  assertExactTuple(value.protocol.versions, [NANOCODEX_PROTOCOL_VERSION], "protocol_version_mismatch");

  assertExactObject(value.checkpoint, [
    "codec",
    "codecVersions",
    "snapshotVersions",
    "continuationModes",
    "resumeRequiresSameCanonicalWorkspace",
  ]);
  assertLiteral(value.checkpoint.codec, "nanocodex.session-snapshot", "checkpoint_codec_mismatch");
  assertExactTuple(value.checkpoint.codecVersions, [1], "checkpoint_version_mismatch");
  assertExactTuple(value.checkpoint.snapshotVersions, [1], "snapshot_version_mismatch");
  assertExactTuple(value.checkpoint.continuationModes, ["resume"], "continuation_mode_mismatch");
  assertLiteral(value.checkpoint.resumeRequiresSameCanonicalWorkspace, true, "workspace_policy_mismatch");

  assertExactTuple(value.authenticationModes, ["api-key-env", "chatgpt"], "authentication_mode_mismatch");
  assertExactTuple(value.transportModes, ["websocket"], "transport_mode_mismatch");
  assertExactTuple(value.models, NANOCODEX_MODELS, "model_mismatch");
  assertLiteral(value.defaultModel, NANOCODEX_DEFAULT_MODEL, "model_mismatch");
  assertExactTuple(value.thinkingLevels, NANOCODEX_THINKING_LEVELS, "feature_mismatch");
  assertLiteral(value.defaultThinking, NANOCODEX_DEFAULT_THINKING, "feature_mismatch");
  assertExactTuple(value.reasoningModes, NANOCODEX_REASONING_MODES, "feature_mismatch");

  assertExactObject(value.features, [
    "codeMode",
    "codeModeDisable",
    "websocketHttpsFallback",
    "customEndpoints",
    "mcp",
    "subagents",
    "steering",
    "workspaceRelocation",
  ]);
  const expectedFeatures = {
    codeMode: true,
    codeModeDisable: false,
    websocketHttpsFallback: true,
    customEndpoints: false,
    mcp: false,
    subagents: false,
    steering: false,
    workspaceRelocation: false,
  };
  for (const key of Object.keys(expectedFeatures)) {
    assertLiteral(value.features[key], expectedFeatures[key], "feature_mismatch");
  }

  const limitKeys = Object.keys(NANOCODEX_LIMITS);
  assertExactObject(value.limits, limitKeys);
  for (const key of limitKeys) {
    assertLiteral(value.limits[key], NANOCODEX_LIMITS[key], "capability_limit_mismatch");
  }

  return /** @type {import("./protocol-types.ts").NanocodexCapabilities} */ (value);
}

/**
 * Strictly validate one bridge output record without retaining process state.
 * Use `createServerRecordValidator` for ordering and correlation validation.
 *
 * @param {unknown} value
 * @returns {import("./protocol-types.ts").NanocodexServerRecord}
 */
export function validateServerRecord(value) {
  assertPlainDataObject(value);
  const type = value.type;
  if (typeof type !== "string") fail("invalid_record", "Nanocodex bridge record is invalid.");

  switch (type) {
    case "hello":
      assertRecordEnvelope(value, []);
      validateNanocodexCapabilities(value.data);
      break;
    case "turn.accepted":
      assertRecordEnvelope(value, ["requestId", "commandId", "sessionId"]);
      assertCorrelationId(value.requestId);
      assertCorrelationId(value.commandId);
      assertCorrelationId(value.sessionId);
      assertExactObject(value.data, []);
      break;
    case "agent.event":
      assertRecordEnvelope(value, ["requestId", "sessionId"]);
      assertCorrelationId(value.requestId);
      assertCorrelationId(value.sessionId);
      assertExactObject(value.data, ["event"]);
      validateProjectedAgentEvent(value.data.event);
      projectedEventCharge(value.data.event);
      break;
    case "agent.event-truncated":
      assertRecordEnvelope(value, ["requestId", "sessionId"]);
      assertCorrelationId(value.requestId);
      assertCorrelationId(value.sessionId);
      assertExactObject(value.data, ["upstreamType", "upstreamSeq", "reason"]);
      if (value.data.upstreamType !== null) {
        assertBoundedString(value.data.upstreamType, 1, 256, "invalid_event_truncation");
      }
      if (value.data.upstreamSeq !== null)
        assertNonNegativeSafeInteger(value.data.upstreamSeq, "invalid_event_truncation");
      if (!TRUNCATION_REASONS.has(value.data.reason)) {
        fail("invalid_event_truncation", "Nanocodex event truncation data is invalid.");
      }
      if (value.data.reason === "bridge_event_backpressure") {
        if (value.data.upstreamType !== null || value.data.upstreamSeq !== null) {
          fail("invalid_event_truncation", "Nanocodex backpressure markers must have null upstream correlation.");
        }
      } else {
        if (value.data.upstreamType === null || value.data.upstreamSeq === null) {
          fail("invalid_event_truncation", "Nanocodex event truncation is missing upstream correlation.");
        }
        if (
          value.data.reason === "event_policy" &&
          value.data.upstreamType !== "api.event" &&
          value.data.upstreamType !== "reasoning.summary.delta"
        ) {
          fail("invalid_event_truncation", "Nanocodex policy truncation has an invalid upstream event type.");
        }
      }
      break;
    case "command.accepted":
      assertRecordEnvelope(value, ["requestId", "commandId"], ["sessionId"]);
      assertCommandCorrelation(value);
      assertExactObject(value.data, ["command"]);
      assertLiteral(value.data.command, "turn.cancel", "invalid_command_outcome");
      break;
    case "command.rejected":
      assertRecordEnvelope(value, ["requestId", "commandId"], ["sessionId"]);
      assertCommandCorrelation(value);
      assertExactObject(value.data, ["error"]);
      validatePublicError(value.data.error);
      break;
    case "turn.completed":
      assertRecordEnvelope(value, ["requestId", "sessionId"]);
      assertTurnCorrelation(value);
      validateCompletedData(value.data);
      break;
    case "turn.failed":
      assertRecordEnvelope(value, ["requestId", "sessionId"]);
      assertTurnCorrelation(value);
      assertExactObject(value.data, ["error"], ["completed"]);
      validatePublicError(value.data.error);
      if ("completed" in value.data) {
        if (value.data.error.category !== "cleanup" || value.data.error.code !== "cleanup_failed") {
          fail("invalid_terminal", "Recoverable completion data requires the cleanup_failed error.");
        }
        validateRecoveryData(value.data.completed);
      }
      break;
    case "turn.cancelled":
      assertRecordEnvelope(value, ["requestId", "sessionId"]);
      assertTurnCorrelation(value);
      assertExactObject(value.data, ["reason"]);
      assertBoundedUntrustedText(value.data.reason, 128, "invalid_terminal");
      break;
    case "process.failed":
      assertRecordEnvelope(value, [], ["requestId"]);
      if ("requestId" in value) assertCorrelationId(value.requestId);
      assertExactObject(value.data, ["error"]);
      validatePublicError(value.data.error);
      break;
    default:
      fail("unsupported_record_type", "Nanocodex bridge record type is not supported by protocol v1.");
  }

  return /** @type {import("./protocol-types.ts").NanocodexServerRecord} */ (value);
}

/**
 * Validate the startup record, including the mandatory first sequence number.
 *
 * @param {unknown} value
 * @returns {import("./protocol-types.ts").NanocodexHelloRecord}
 */
export function validateHelloRecord(value) {
  const record = validateServerRecord(value);
  if (record.type !== "hello" || record.seq !== 1) {
    fail("invalid_hello", "The first Nanocodex bridge record must be hello with sequence 1.");
  }
  return record;
}

/**
 * Construct a per-process validator. The returned function enforces hello
 * first, safe monotonic sequence numbers, exact turn correlation, and one
 * terminal outcome.
 *
 * @param {{ requestId?: string; startCommandId?: string }} [options]
 * The callable validator also exposes `registerCancelCommand(command)`. The
 * caller must invoke it synchronously immediately before sending each outbound
 * turn.cancel command; command outcomes for any other ID are rejected.
 *
 * @returns {((value: unknown) => import("./protocol-types.ts").NanocodexServerRecord) & { registerCancelCommand(command: import("./protocol-types.ts").NanocodexTurnCancelCommand): void }}
 */
export function createServerRecordValidator(options = {}) {
  assertExactObject(options, [], ["requestId", "startCommandId"]);
  if ("requestId" in options) assertCorrelationId(options.requestId);
  if ("startCommandId" in options) assertCorrelationId(options.startCommandId);

  let nextSeq = 1;
  let helloSeen = false;
  let terminalSeen = false;
  let accepted = false;
  let expectedRequestId = options.requestId;
  let expectedStartCommandId = options.startCommandId;
  let activeSessionId;
  let chargedEventBytes = 0;
  let visibleEventChargeIndeterminate = false;
  let aggregateEventLimitSeen = false;
  let acceptedCancellationPhase;
  const usedCommandIds = new Set(expectedStartCommandId === undefined ? [] : [expectedStartCommandId]);
  const pendingCancelCommandIds = new Set();

  const validate = (value) => {
    if (terminalSeen) fail("record_after_terminal", "The Nanocodex bridge emitted data after its terminal record.");
    const record = validateServerRecord(value);
    if (record.seq !== nextSeq) {
      fail("invalid_sequence", "Nanocodex bridge sequence numbers must start at 1 and increase by one.");
    }
    if (!helloSeen) {
      if (record.type !== "hello") {
        fail("missing_hello", "The first Nanocodex bridge record must be hello.");
      }
    } else if (record.type === "hello") {
      fail("duplicate_hello", "The Nanocodex bridge emitted more than one hello record.");
    }

    switch (record.type) {
      case "hello":
        break;
      case "turn.accepted":
        if (accepted) fail("duplicate_acceptance", "The Nanocodex bridge accepted the turn more than once.");
        if (acceptedCancellationPhase === "pre-session") {
          fail("turn_accepted_after_cancel", "The Nanocodex bridge accepted a turn after acknowledging cancellation.");
        }
        assertExpectedCorrelation(record.requestId, expectedRequestId);
        assertExpectedCorrelation(record.commandId, expectedStartCommandId);
        if (expectedStartCommandId === undefined && usedCommandIds.has(record.commandId)) {
          fail("duplicate_command_id", "The Nanocodex bridge reused a registered command identifier.");
        }
        expectedRequestId ??= record.requestId;
        expectedStartCommandId ??= record.commandId;
        usedCommandIds.add(record.commandId);
        break;
      case "agent.event":
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled":
        if (!accepted)
          fail("record_before_acceptance", "The Nanocodex bridge emitted a turn record before acceptance.");
        assertExpectedCorrelation(record.requestId, expectedRequestId);
        assertExpectedCorrelation(record.sessionId, activeSessionId);
        if (
          acceptedCancellationPhase === "exact-session" &&
          record.type !== "agent.event" &&
          record.type !== "turn.cancelled"
        ) {
          fail(
            "invalid_cancel_terminal",
            "The Nanocodex bridge emitted the wrong terminal after acknowledging cancellation.",
          );
        }
        if (record.type === "agent.event") {
          if (aggregateEventLimitSeen) {
            fail("event_after_aggregate_limit", "Nanocodex bridge emitted an event after aggregate suppression.");
          }
          const charge = projectedEventCharge(record.data.event);
          if (chargedEventBytes + charge + EVENT_WIRE_ENVELOPE_RESERVE > NANOCODEX_LIMITS.maxEventTotalBytes) {
            fail("aggregate_event_limit_missing", "Nanocodex bridge omitted the aggregate event-limit marker.");
          }
          chargedEventBytes += charge;
        }
        break;
      case "agent.event-truncated":
        if (!accepted)
          fail("record_before_acceptance", "The Nanocodex bridge emitted a turn record before acceptance.");
        assertExpectedCorrelation(record.requestId, expectedRequestId);
        assertExpectedCorrelation(record.sessionId, activeSessionId);
        if (aggregateEventLimitSeen) {
          fail("event_after_aggregate_limit", "Nanocodex bridge emitted an event after aggregate suppression.");
        }
        if (record.data.reason === "aggregate_event_limit") {
          if (
            !visibleEventChargeIndeterminate &&
            chargedEventBytes + NANOCODEX_LIMITS.maxEventBytes + EVENT_WIRE_ENVELOPE_RESERVE <=
              NANOCODEX_LIMITS.maxEventTotalBytes
          ) {
            fail("premature_aggregate_event_limit", "Nanocodex bridge emitted an aggregate event-limit marker early.");
          }
          aggregateEventLimitSeen = true;
        } else if (record.data.reason === "bridge_event_backpressure") {
          visibleEventChargeIndeterminate = true;
        } else {
          if (chargedEventBytes + 2 * EVENT_WIRE_ENVELOPE_RESERVE > NANOCODEX_LIMITS.maxEventTotalBytes) {
            fail("aggregate_event_limit_missing", "Nanocodex bridge omitted the aggregate event-limit marker.");
          }
          chargedEventBytes += EVENT_WIRE_ENVELOPE_RESERVE;
        }
        break;
      case "command.accepted":
      case "command.rejected":
        if (!pendingCancelCommandIds.has(record.commandId)) {
          fail("unregistered_command_outcome", "Nanocodex bridge command outcome was not registered by the caller.");
        }
        assertExpectedCorrelation(record.requestId, expectedRequestId);
        if (accepted) {
          if (!("sessionId" in record)) {
            fail("correlation_mismatch", "The Nanocodex bridge command outcome is missing active turn correlation.");
          }
          assertExpectedCorrelation(record.sessionId, activeSessionId);
        } else if ("sessionId" in record) {
          fail("correlation_mismatch", "The Nanocodex bridge correlated a command to an inactive session.");
        }
        pendingCancelCommandIds.delete(record.commandId);
        if (record.type === "command.accepted") {
          acceptedCancellationPhase = accepted ? "exact-session" : "pre-session";
        }
        break;
      case "process.failed":
        if (accepted) fail("invalid_terminal", "process.failed is only valid before turn acceptance.");
        if ("requestId" in record) assertExpectedCorrelation(record.requestId, expectedRequestId);
        break;
    }

    if (TERMINAL_TYPES.has(record.type) && pendingCancelCommandIds.size > 0) {
      fail("missing_command_outcome", "Nanocodex bridge terminated before acknowledging a registered command.");
    }

    nextSeq += 1;
    helloSeen = true;
    if (record.type === "turn.accepted") {
      accepted = true;
      activeSessionId = record.sessionId;
    }
    if (TERMINAL_TYPES.has(record.type)) terminalSeen = true;
    return record;
  };

  Object.defineProperty(validate, "registerCancelCommand", {
    enumerable: false,
    value(command) {
      if (!helloSeen || terminalSeen) {
        fail("invalid_command_registration", "A Nanocodex cancel command cannot be registered in the current state.");
      }
      validateTurnCancelCommand(command);
      assertExpectedCorrelation(command.requestId, expectedRequestId);
      expectedRequestId ??= command.requestId;
      if (accepted) {
        if (!("sessionId" in command) || command.sessionId === null) {
          fail("correlation_mismatch", "The outbound cancel command is missing active turn correlation.");
        }
        assertExpectedCorrelation(command.sessionId, activeSessionId);
      } else if ("sessionId" in command) {
        fail("correlation_mismatch", "The outbound cancel command names an inactive session.");
      }
      if (usedCommandIds.has(command.commandId)) {
        fail("duplicate_command_id", "A Nanocodex command identifier may be registered only once.");
      }
      usedCommandIds.add(command.commandId);
      pendingCancelCommandIds.add(command.commandId);
    },
  });
  return validate;
}

/**
 * @param {unknown} value
 * @returns {value is import("./protocol-types.ts").NanocodexHelloRecord}
 */
export function isHelloRecord(value) {
  return isPlainObject(value) && Object.getOwnPropertyDescriptor(value, "type")?.value === "hello";
}

/**
 * @param {unknown} value
 * @returns {value is import("./protocol-types.ts").NanocodexTurnCompletedRecord | import("./protocol-types.ts").NanocodexTurnFailedRecord | import("./protocol-types.ts").NanocodexTurnCancelledRecord | import("./protocol-types.ts").NanocodexProcessFailedRecord}
 */
export function isTerminalServerRecord(value) {
  if (!isPlainObject(value)) return false;
  return TERMINAL_TYPES.has(Object.getOwnPropertyDescriptor(value, "type")?.value);
}

/**
 * Build and clone one strict v1 turn.start command. Credential values are not
 * accepted; API-key authentication names an inherited environment variable.
 *
 * @param {{
 *   commandId: string;
 *   requestId: string;
 *   prompt: string;
 *   workspace: string;
 *   auth: import("./protocol-types.ts").NanocodexAuthConfig;
 *   transport?: { kind: "websocket" };
 *   options?: import("./protocol-types.ts").NanocodexTurnOptions;
 *   continuation?: import("./protocol-types.ts").NanocodexTurnContinuation | null;
 * }} input
 * @returns {import("./protocol-types.ts").NanocodexTurnStartCommand}
 */
export function createTurnStartCommand(input) {
  assertExactObject(
    input,
    ["commandId", "requestId", "prompt", "workspace", "auth"],
    ["transport", "options", "continuation"],
  );
  assertCorrelationId(input.commandId);
  assertCorrelationId(input.requestId);
  if (typeof input.prompt !== "string") {
    fail("invalid_turn_start", "Nanocodex prompt is empty or exceeds the protocol v1 byte limit.");
  }
  assertUnicodeScalarString(input.prompt, "invalid_turn_start");
  if (
    RUST_UNICODE_WHITESPACE_ONLY.test(input.prompt) ||
    Buffer.byteLength(input.prompt, "utf8") > NANOCODEX_LIMITS.maxPromptBytes
  ) {
    fail("invalid_turn_start", "Nanocodex prompt is empty or exceeds the protocol v1 byte limit.");
  }
  assertAbsoluteWorkspace(input.workspace);
  validateAuth(input.auth);
  const transport = input.transport === undefined ? { kind: "websocket" } : input.transport;
  validateTransport(transport);
  const options = input.options === undefined ? {} : input.options;
  validateTurnOptions(options);
  const continuation = input.continuation ?? null;
  validateContinuation(continuation);

  return cloneStrictJson({
    protocol: NANOCODEX_PROTOCOL_NAME,
    version: NANOCODEX_PROTOCOL_VERSION,
    type: "turn.start",
    commandId: input.commandId,
    requestId: input.requestId,
    data: {
      prompt: input.prompt,
      workspace: input.workspace,
      auth: input.auth,
      transport,
      options,
      continuation,
    },
  });
}

/**
 * Build and clone one strict v1 turn.cancel command. Omit `sessionId` before
 * turn acceptance and supply the exact accepted session afterwards.
 *
 * @param {{ commandId: string; requestId: string; sessionId?: string | null; reason?: string | null }} input
 * @returns {import("./protocol-types.ts").NanocodexTurnCancelCommand}
 */
export function createTurnCancelCommand(input) {
  assertExactObject(input, ["commandId", "requestId"], ["sessionId", "reason"]);
  assertCorrelationId(input.commandId);
  assertCorrelationId(input.requestId);
  if (input.sessionId !== undefined && input.sessionId !== null) assertCorrelationId(input.sessionId);
  if (input.reason !== undefined && input.reason !== null) {
    assertBoundedUntrustedText(input.reason, 128, "invalid_turn_cancel");
  }
  const command = cloneStrictJson({
    protocol: NANOCODEX_PROTOCOL_NAME,
    version: NANOCODEX_PROTOCOL_VERSION,
    type: "turn.cancel",
    commandId: input.commandId,
    requestId: input.requestId,
    ...(input.sessionId == null ? {} : { sessionId: input.sessionId }),
    data: input.reason == null ? {} : { reason: input.reason },
  });
  validateTurnCancelCommand(command);
  return command;
}

/**
 * Measure the serialized JSON record body only. The JSONL LF delimiter is
 * deliberately excluded from both v1 input and output record byte limits.
 *
 * @param {unknown} record
 */
export function getNanocodexRecordBodyByteLength(record) {
  assertStrictJsonValue(record);
  return encodedJsonBytes(record);
}

/** @param {Record<string, unknown>} record @param {string[]} requiredCorrelation @param {string[]} [optionalCorrelation] */
function assertRecordEnvelope(record, requiredCorrelation, optionalCorrelation = []) {
  assertExactObject(
    record,
    ["protocol", "version", "type", "seq", "data", ...requiredCorrelation],
    optionalCorrelation,
  );
  assertLiteral(record.protocol, NANOCODEX_PROTOCOL_NAME, "protocol_name_mismatch");
  assertLiteral(record.version, NANOCODEX_PROTOCOL_VERSION, "protocol_version_mismatch");
  assertPositiveSafeInteger(record.seq, "invalid_sequence");
}

/** @param {Record<string, unknown>} record */
function assertCommandCorrelation(record) {
  assertCorrelationId(record.requestId);
  assertCorrelationId(record.commandId);
  if ("sessionId" in record) assertCorrelationId(record.sessionId);
}

/** @param {Record<string, unknown>} record */
function assertTurnCorrelation(record) {
  assertCorrelationId(record.requestId);
  assertCorrelationId(record.sessionId);
}

/** @param {unknown} value */
function validateTurnCancelCommand(value) {
  assertExactObject(value, ["protocol", "version", "type", "commandId", "requestId", "data"], ["sessionId"]);
  assertLiteral(value.protocol, NANOCODEX_PROTOCOL_NAME, "protocol_name_mismatch");
  assertLiteral(value.version, NANOCODEX_PROTOCOL_VERSION, "protocol_version_mismatch");
  assertLiteral(value.type, "turn.cancel", "invalid_turn_cancel");
  assertCorrelationId(value.commandId);
  assertCorrelationId(value.requestId);
  if ("sessionId" in value) assertCorrelationId(value.sessionId);
  assertExactObject(value.data, [], ["reason"]);
  if ("reason" in value.data) assertBoundedUntrustedText(value.data.reason, 128, "invalid_turn_cancel");
}

/** @param {unknown} value */
function validateCompletedData(value) {
  assertExactObject(value, ["finalMessage", "usage", "model", "snapshotVersion", "snapshot", "canonicalWorkspace"]);
  assertBoundedString(value.finalMessage, 0, Number.MAX_SAFE_INTEGER, "invalid_completed_data");
  validateUsage(value.usage);
  assertNanocodexWireModel(value.model);
  assertLiteral(value.snapshotVersion, 1, "snapshot_version_mismatch");
  assertStrictJsonValue(value.snapshot);
  if (!isPlainObject(value.snapshot)) fail("invalid_snapshot", "Nanocodex snapshot must be a JSON object.");
  assertAbsoluteWorkspace(value.canonicalWorkspace);
}

/** @param {unknown} value */
function validateRecoveryData(value) {
  assertExactObject(value, ["model", "snapshotVersion", "snapshot", "canonicalWorkspace"]);
  assertNanocodexWireModel(value.model);
  assertLiteral(value.snapshotVersion, 1, "snapshot_version_mismatch");
  assertStrictJsonValue(value.snapshot);
  if (!isPlainObject(value.snapshot)) fail("invalid_snapshot", "Nanocodex snapshot must be a JSON object.");
  assertAbsoluteWorkspace(value.canonicalWorkspace);
}

/** @param {unknown} value */
function validateProjectedAgentEvent(value) {
  assertExactObject(value, ["type", "upstreamSeq", "payload"]);
  assertBoundedString(value.type, 1, 256, "invalid_agent_event");
  assertNonNegativeSafeInteger(value.upstreamSeq, "invalid_agent_event");
  assertPlainDataObject(value.payload);

  switch (value.type) {
    case "assistant.delta":
    case "assistant.message":
      assertExactObject(value.payload, ["modelCallIndex", "itemId", "phase", "text"]);
      assertNonNegativeSafeInteger(value.payload.modelCallIndex, "invalid_agent_event");
      if (value.payload.itemId !== null && typeof value.payload.itemId !== "string") {
        fail("invalid_agent_event", "Nanocodex projected assistant event is invalid.");
      }
      if (value.payload.phase !== null && !ASSISTANT_PHASES.has(value.payload.phase)) {
        fail("invalid_agent_event", "Nanocodex projected assistant event is invalid.");
      }
      if (typeof value.payload.text !== "string") {
        fail("invalid_agent_event", "Nanocodex projected assistant event is invalid.");
      }
      break;
    case "tool.call":
      assertExactObject(value.payload, ["callId", "tool", "modelCallIndex"]);
      assertProjectedToolIdentifier(value.payload.callId, PROJECTED_TOOL_CALL_ID_MAX_BYTES);
      assertProjectedToolIdentifier(value.payload.tool, PROJECTED_TOOL_NAME_MAX_BYTES);
      assertNonNegativeSafeInteger(value.payload.modelCallIndex, "invalid_agent_event");
      break;
    case "tool.result":
      assertExactObject(value.payload, ["callId", "tool", "status", "durationNs", "startedAfterNs"]);
      assertProjectedToolIdentifier(value.payload.callId, PROJECTED_TOOL_CALL_ID_MAX_BYTES);
      assertProjectedToolIdentifier(value.payload.tool, PROJECTED_TOOL_NAME_MAX_BYTES);
      if (!TOOL_RESULT_STATUSES.has(value.payload.status)) {
        fail("invalid_agent_event", "Nanocodex projected tool result is invalid.");
      }
      assertNonNegativeSafeInteger(value.payload.durationNs, "invalid_agent_event");
      if (value.payload.startedAfterNs !== null) {
        assertNonNegativeSafeInteger(value.payload.startedAfterNs, "invalid_agent_event");
      }
      break;
    case "api.event":
    case "reasoning.summary.delta":
      fail("invalid_agent_event", "Nanocodex policy-only event was emitted as an ordinary agent event.");
      break;
    default:
      if (PROJECTED_LIFECYCLE_EVENT_TYPES.has(value.type)) {
        assertExactObject(value.payload, []);
      } else {
        // Unknown upstream event kinds are the sole open v1 projection point.
        // Their payload remains validated JSON but must be ignored by callers.
        assertStrictJsonValue(value.payload);
      }
  }
}

/** @param {unknown} value */
function projectedEventCharge(value) {
  const charge = encodedJsonBytes(value) + EVENT_WIRE_ENVELOPE_RESERVE;
  if (charge > NANOCODEX_LIMITS.maxEventBytes) {
    fail("invalid_agent_event", "Nanocodex projected event exceeds the per-event protocol limit.");
  }
  return charge;
}

/** @param {unknown} value */
function validateUsage(value) {
  const tokenKeys = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ];
  assertExactObject(value, [...tokenKeys, "estimatedUsd", "costStatus", "serviceTier"]);
  for (const key of tokenKeys) assertNonNegativeSafeInteger(value[key], "invalid_usage");
  if (
    value.estimatedUsd !== null &&
    !(typeof value.estimatedUsd === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(value.estimatedUsd))
  ) {
    fail("invalid_usage", "Nanocodex usage data is invalid.");
  }
  assertBoundedString(value.costStatus, 1, 128, "invalid_usage");
  if (value.serviceTier !== null) assertBoundedString(value.serviceTier, 1, 128, "invalid_usage");
}

/** @param {unknown} value */
function validatePublicError(value) {
  assertExactObject(value, ["code", "category", "message", "retry"], ["retryAfterMs"]);
  if (typeof value.code !== "string" || !ERROR_CODE.test(value.code)) {
    fail("invalid_public_error", "Nanocodex public error is invalid.");
  }
  if (!ERROR_CATEGORIES.has(value.category) || !RETRY_DISPOSITIONS.has(value.retry)) {
    fail("invalid_public_error", "Nanocodex public error is invalid.");
  }
  assertBoundedString(value.message, 1, 513, "invalid_public_error");
  if (value.retry === "after" && !("retryAfterMs" in value)) {
    fail("invalid_public_error", "retry after requires retryAfterMs.");
  }
  if ("retryAfterMs" in value) {
    if (value.retry !== "after") fail("invalid_public_error", "retryAfterMs requires retry after.");
    assertNonNegativeSafeInteger(value.retryAfterMs, "invalid_public_error");
  }
}

/** @param {unknown} value */
function validateAuth(value) {
  assertPlainDataObject(value);
  if (value.mode === "api-key-env") {
    assertExactObject(value, ["mode", "environmentVariable"]);
    if (typeof value.environmentVariable !== "string" || !ENVIRONMENT_NAME.test(value.environmentVariable)) {
      fail("invalid_auth", "Nanocodex API-key environment variable name is invalid.");
    }
    return;
  }
  if (value.mode === "chatgpt") {
    assertExactObject(value, ["mode"], ["authFile"]);
    if ("authFile" in value && value.authFile !== null) {
      if (typeof value.authFile === "string") assertUnicodeScalarString(value.authFile, "invalid_auth");
      if (
        typeof value.authFile !== "string" ||
        value.authFile.length === 0 ||
        value.authFile.length > 4096 ||
        value.authFile.includes("\0") ||
        !isAbsolute(value.authFile)
      ) {
        fail("invalid_auth", "Nanocodex managed authentication path must be an absolute bounded path.");
      }
    }
    return;
  }
  fail("invalid_auth", "Nanocodex authentication mode is not supported by protocol v1.");
}

/** @param {unknown} value */
function validateTransport(value) {
  assertExactObject(value, ["kind"]);
  assertLiteral(value.kind, "websocket", "invalid_transport");
}

/** @param {unknown} value */
function validateTurnOptions(value) {
  assertExactObject(value, [], ["instructions", "model", "thinking", "reasoningMode", "fastMode"]);
  if ("instructions" in value && value.instructions !== null) {
    if (typeof value.instructions !== "string") {
      fail("invalid_turn_options", "Nanocodex instructions must be a nonempty bounded string or null.");
    }
    assertUnicodeScalarString(value.instructions, "invalid_turn_options");
    if (
      RUST_UNICODE_WHITESPACE_ONLY.test(value.instructions) ||
      Buffer.byteLength(value.instructions, "utf8") > NANOCODEX_LIMITS.maxPromptBytes
    ) {
      fail("invalid_turn_options", "Nanocodex instructions must be a nonempty bounded string or null.");
    }
  }
  if ("model" in value && value.model !== null && normalizeNanocodexModel(value.model) === undefined) {
    fail("invalid_turn_options", "Nanocodex model is not supported by protocol v1.");
  }
  if ("thinking" in value && value.thinking !== null && !THINKING_LEVELS.has(value.thinking)) {
    fail("invalid_turn_options", "Nanocodex thinking level is not supported by protocol v1.");
  }
  if ("reasoningMode" in value && value.reasoningMode !== null && !REASONING_MODES.has(value.reasoningMode)) {
    fail("invalid_turn_options", "Nanocodex reasoning mode is not supported by protocol v1.");
  }
  if ("fastMode" in value && value.fastMode !== null && typeof value.fastMode !== "boolean") {
    fail("invalid_turn_options", "Nanocodex fastMode must be boolean.");
  }
}

/** @param {unknown} value */
function validateContinuation(value) {
  if (value === null) return;
  assertExactObject(value, ["mode", "snapshot"]);
  assertLiteral(value.mode, "resume", "continuation_mode_mismatch");
  assertStrictJsonValue(value.snapshot);
  if (!isPlainObject(value.snapshot)) fail("invalid_snapshot", "Nanocodex snapshot must be a JSON object.");
}

/** @param {unknown} actual @param {unknown} expected */
function assertExpectedCorrelation(actual, expected) {
  if (expected !== undefined && actual !== expected) {
    fail("correlation_mismatch", "Nanocodex bridge record correlation does not match the active turn.");
  }
}

/** @param {unknown} value */
function assertCorrelationId(value) {
  if (typeof value !== "string" || !CORRELATION_ID.test(value)) {
    fail("invalid_correlation_id", "Nanocodex correlation identifiers must use 1 to 128 safe ASCII bytes.");
  }
}

/** @param {unknown} value */
function assertAbsoluteWorkspace(value) {
  if (typeof value === "string") assertUnicodeScalarString(value, "invalid_workspace");
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    fail("invalid_workspace", "Nanocodex workspace must be an absolute path.");
  }
}

/** @param {unknown} value @param {number} minimum @param {number} maximum @param {string} code */
function assertBoundedString(value, minimum, maximum, code) {
  if (typeof value !== "string") {
    fail(code, "Nanocodex protocol string is invalid.");
  }
  const length = unicodeScalarLength(value, code);
  if (length < minimum || length > maximum) fail(code, "Nanocodex protocol string is invalid.");
}

/** @param {unknown} value @param {number} maximumBytes @param {string} code */
function assertBoundedUntrustedText(value, maximumBytes, code) {
  if (typeof value !== "string") {
    fail(code, "Nanocodex protocol untrusted text is invalid.");
  }
  assertUnicodeScalarString(value, code);
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes || /\p{Cc}/u.test(value)) {
    fail(code, "Nanocodex protocol untrusted text is invalid.");
  }
}

/** @param {unknown} value @param {number} maximumBytes */
function assertProjectedToolIdentifier(value, maximumBytes) {
  if (typeof value !== "string") {
    fail("invalid_agent_event", "Nanocodex projected tool identifier is invalid.");
  }
  assertUnicodeScalarString(value, "invalid_agent_event");
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes || /\p{Cc}/u.test(value)) {
    fail("invalid_agent_event", "Nanocodex projected tool identifier is invalid.");
  }
}

/** @param {string} value @param {string} code */
function assertUnicodeScalarString(value, code) {
  unicodeScalarLength(value, code);
}

/** @param {string} value @param {string} code */
function unicodeScalarLength(value, code) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(code, "Nanocodex protocol string contains an unpaired UTF-16 surrogate.");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(code, "Nanocodex protocol string contains an unpaired UTF-16 surrogate.");
    }
    length += 1;
  }
  return length;
}

/** @param {unknown} value */
function encodedJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** @param {unknown} value @param {string} code */
function assertPositiveSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code, "Nanocodex protocol integer is invalid.");
}

/** @param {unknown} value @param {string} code */
function assertNonNegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, "Nanocodex protocol integer is invalid.");
}

/** @param {unknown} value */
function assertNanocodexWireModel(value) {
  if (typeof value !== "string" || !NANOCODEX_MODELS.includes(value)) {
    fail("invalid_completed_data", "Nanocodex model is not supported by protocol v1.");
  }
}

function assertLiteral(value, expected, code) {
  if (value !== expected) fail(code, "Nanocodex protocol capability is incompatible.");
}

/** @param {unknown} value @param {unknown[]} expected @param {string} code */
function assertExactTuple(value, expected, code) {
  assertStrictArray(value);
  if (value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    fail(code, "Nanocodex protocol capability is incompatible.");
  }
}

/**
 * @param {unknown} value
 * @param {string[]} required
 * @param {string[]} [optional]
 * @returns {asserts value is Record<string, any>}
 */
function assertExactObject(value, required, optional = []) {
  assertPlainDataObject(value);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.length < required.length ||
    keys.length > allowed.size ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    fail("invalid_object_shape", "Nanocodex protocol object has an invalid field set.");
  }
}

/** @param {unknown} value @returns {asserts value is Record<string, any>} */
function assertPlainDataObject(value) {
  if (!isPlainObject(value)) fail("invalid_object", "Nanocodex protocol value must be a plain object.");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
      fail("invalid_object", "Nanocodex protocol object must contain enumerable data properties only.");
    }
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value */
function assertStrictArray(value) {
  if (!Array.isArray(value)) fail("invalid_array", "Nanocodex protocol value must be an array.");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) fail("invalid_array", "Nanocodex protocol array is invalid.");
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("invalid_array", "Nanocodex protocol array must contain data entries only.");
    }
  }
}

/**
 * Validate one in-memory value against the producer's strict JSON parser and
 * Smithers' stable-number/data-property requirements. Root is depth level 1.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function validateNanocodexStrictJsonValue(value) {
  assertStrictJsonValue(value);
  return value;
}

/** @param {unknown} value */
function assertStrictJsonValue(value) {
  let nodes = 0;
  const ancestors = new Set();
  const pending = [{ value, depth: 1, exit: false }];

  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry.exit) {
      ancestors.delete(entry.value);
      continue;
    }
    if (entry.depth > NANOCODEX_LIMITS.maxJsonDepth) {
      fail("json_depth_limit", "Nanocodex protocol JSON exceeds the nesting limit.");
    }
    nodes += 1;
    if (nodes > NANOCODEX_LIMITS.maxJsonNodes) {
      fail("json_node_limit", "Nanocodex protocol JSON exceeds the total-node limit.");
    }

    const current = entry.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      assertUnicodeScalarString(current, "invalid_json_value");
      if (Buffer.byteLength(current, "utf8") > NANOCODEX_LIMITS.maxJsonStringBytes) {
        fail("json_string_limit", "Nanocodex protocol JSON string exceeds the decoded UTF-8 limit.");
      }
      continue;
    }
    if (typeof current === "number") {
      if (
        !Number.isFinite(current) ||
        Object.is(current, -0) ||
        (Number.isInteger(current) && !Number.isSafeInteger(current))
      ) {
        fail("invalid_json_value", "Nanocodex protocol data is not stable JSON.");
      }
      continue;
    }
    if (typeof current !== "object") {
      fail("invalid_json_value", "Nanocodex protocol data is not stable JSON.");
    }
    if (ancestors.has(current)) fail("invalid_json_value", "Nanocodex protocol data contains a cycle.");
    ancestors.add(current);
    pending.push({ value: current, depth: entry.depth, exit: true });

    if (Array.isArray(current)) {
      assertStrictArray(current);
      if (current.length > NANOCODEX_LIMITS.maxJsonArrayElements) {
        fail("json_array_limit", "Nanocodex protocol JSON array exceeds the element limit.");
      }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: Object.getOwnPropertyDescriptor(current, String(index)).value,
          depth: entry.depth + 1,
          exit: false,
        });
      }
      continue;
    }

    assertPlainDataObject(current);
    const keys = Reflect.ownKeys(current);
    if (keys.length > NANOCODEX_LIMITS.maxJsonObjectMembers) {
      fail("json_object_limit", "Nanocodex protocol JSON object exceeds the member limit.");
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      assertUnicodeScalarString(key, "invalid_json_value");
      if (Buffer.byteLength(key, "utf8") > NANOCODEX_LIMITS.maxJsonKeyBytes) {
        fail("json_key_limit", "Nanocodex protocol JSON object key exceeds the UTF-8 limit.");
      }
      pending.push({
        value: Object.getOwnPropertyDescriptor(current, key).value,
        depth: entry.depth + 1,
        exit: false,
      });
    }
  }
}

/** @template T @param {T} value @returns {T} */
function cloneStrictJson(value) {
  assertStrictJsonValue(value);
  return JSON.parse(JSON.stringify(value));
}

/** @returns {never} @param {string} code @param {string} message */
function fail(code, message) {
  throw new NanocodexProtocolValidationError(code, message);
}

/** @param {string} text */
function scanJsonForDuplicateKeys(text) {
  let index = 0;
  let nodes = 0;
  const isDigit = (character) => character !== undefined && character >= "0" && character <= "9";
  const skipWhitespace = () => {
    while (
      index < text.length &&
      (text[index] === " " || text[index] === "\t" || text[index] === "\n" || text[index] === "\r")
    ) {
      index += 1;
    }
  };

  /** @param {boolean} capture @param {number} maximumBytes @returns {string | undefined} */
  const scanString = (capture, maximumBytes) => {
    if (text[index] !== '"') throw new Error("string expected");
    index += 1;
    let decodedBytes = 0;
    let decoded = capture ? "" : undefined;
    const appendCodePoint = (codePoint) => {
      decodedBytes += utf8CodePointBytes(codePoint);
      if (decodedBytes > maximumBytes) {
        fail(
          capture ? "json_key_limit" : "json_string_limit",
          capture
            ? "Nanocodex protocol JSON object key exceeds the UTF-8 limit."
            : "Nanocodex protocol JSON string exceeds the decoded UTF-8 limit.",
        );
      }
      if (capture) decoded += String.fromCodePoint(codePoint);
    };
    while (index < text.length) {
      const codeUnit = text.charCodeAt(index);
      if (codeUnit === 0x22) {
        index += 1;
        return decoded;
      }
      if (codeUnit === 0x5c) {
        index += 1;
        const escape = text[index];
        index += 1;
        if (escape === "u") {
          const first = scanUnicodeEscape(text, index);
          index += 4;
          if (first >= 0xd800 && first <= 0xdbff) {
            if (text[index] !== "\\" || text[index + 1] !== "u") {
              fail("invalid_json_value", "Nanocodex protocol JSON contains an unpaired UTF-16 surrogate.");
            }
            const second = scanUnicodeEscape(text, index + 2);
            if (second < 0xdc00 || second > 0xdfff) {
              fail("invalid_json_value", "Nanocodex protocol JSON contains an unpaired UTF-16 surrogate.");
            }
            index += 6;
            appendCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
          } else if (first >= 0xdc00 && first <= 0xdfff) {
            fail("invalid_json_value", "Nanocodex protocol JSON contains an unpaired UTF-16 surrogate.");
          } else {
            appendCodePoint(first);
          }
        } else {
          let escapedCodePoint;
          switch (escape) {
            case '"':
              escapedCodePoint = 0x22;
              break;
            case "\\":
              escapedCodePoint = 0x5c;
              break;
            case "/":
              escapedCodePoint = 0x2f;
              break;
            case "b":
              escapedCodePoint = 0x08;
              break;
            case "f":
              escapedCodePoint = 0x0c;
              break;
            case "n":
              escapedCodePoint = 0x0a;
              break;
            case "r":
              escapedCodePoint = 0x0d;
              break;
            case "t":
              escapedCodePoint = 0x09;
              break;
            default:
              throw new Error("invalid string escape");
          }
          appendCodePoint(escapedCodePoint);
        }
        continue;
      }
      if (codeUnit <= 0x1f) throw new Error("unescaped control character");
      index += 1;
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const second = text.charCodeAt(index);
        if (second < 0xdc00 || second > 0xdfff) {
          fail("invalid_json_value", "Nanocodex protocol JSON contains an unpaired UTF-16 surrogate.");
        }
        index += 1;
        appendCodePoint(0x10000 + ((codeUnit - 0xd800) << 10) + (second - 0xdc00));
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        fail("invalid_json_value", "Nanocodex protocol JSON contains an unpaired UTF-16 surrogate.");
      } else {
        appendCodePoint(codeUnit);
      }
    }
    throw new Error("unterminated string");
  };

  const scanNumber = () => {
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
    } else {
      if (text[index] === undefined || text[index] < "1" || text[index] > "9") throw new Error("number expected");
      while (isDigit(text[index])) index += 1;
    }
    if (text[index] === ".") {
      index += 1;
      if (!isDigit(text[index])) throw new Error("fraction expected");
      while (isDigit(text[index])) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!isDigit(text[index])) throw new Error("exponent expected");
      while (isDigit(text[index])) index += 1;
    }
  };

  /** @param {number} depth */
  const scanValue = (depth) => {
    skipWhitespace();
    if (depth > NANOCODEX_LIMITS.maxJsonDepth) {
      fail("json_depth_limit", "Nanocodex protocol JSON exceeds the nesting limit.");
    }
    nodes += 1;
    if (nodes > NANOCODEX_LIMITS.maxJsonNodes) {
      fail("json_node_limit", "Nanocodex protocol JSON exceeds the total-node limit.");
    }
    const character = text[index];
    if (character === "{") {
      index += 1;
      const keys = new Set();
      let members = 0;
      skipWhitespace();
      if (text[index] !== "}") {
        while (true) {
          skipWhitespace();
          if (text[index] !== '"') throw new Error("object key expected");
          const key = scanString(true, NANOCODEX_LIMITS.maxJsonKeyBytes);
          if (keys.has(key)) fail("duplicate_json_key", "Nanocodex protocol JSON contains a duplicate object key.");
          keys.add(key);
          members += 1;
          if (members > NANOCODEX_LIMITS.maxJsonObjectMembers) {
            fail("json_object_limit", "Nanocodex protocol JSON object exceeds the member limit.");
          }
          skipWhitespace();
          if (text[index] !== ":") throw new Error("colon expected");
          index += 1;
          scanValue(depth + 1);
          skipWhitespace();
          if (text[index] === "}") break;
          if (text[index] !== ",") throw new Error("comma expected");
          index += 1;
        }
      }
      index += 1;
    } else if (character === "[") {
      index += 1;
      let elements = 0;
      skipWhitespace();
      if (text[index] !== "]") {
        while (true) {
          elements += 1;
          if (elements > NANOCODEX_LIMITS.maxJsonArrayElements) {
            fail("json_array_limit", "Nanocodex protocol JSON array exceeds the element limit.");
          }
          scanValue(depth + 1);
          skipWhitespace();
          if (text[index] === "]") break;
          if (text[index] !== ",") throw new Error("comma expected");
          index += 1;
        }
      }
      index += 1;
    } else if (character === '"') {
      scanString(false, NANOCODEX_LIMITS.maxJsonStringBytes);
    } else if (text.startsWith("true", index)) {
      index += 4;
    } else if (text.startsWith("false", index)) {
      index += 5;
    } else if (text.startsWith("null", index)) {
      index += 4;
    } else if (character === "-" || (character >= "0" && character <= "9")) {
      scanNumber();
    } else {
      throw new Error("value expected");
    }
  };
  scanValue(1);
  skipWhitespace();
  if (index !== text.length) throw new Error("trailing data");
}

/** @param {string} text @param {number} index */
function scanUnicodeEscape(text, index) {
  let value = 0;
  for (let offset = 0; offset < 4; offset += 1) {
    const codeUnit = text.charCodeAt(index + offset);
    let digit;
    if (codeUnit >= 0x30 && codeUnit <= 0x39) digit = codeUnit - 0x30;
    else if (codeUnit >= 0x41 && codeUnit <= 0x46) digit = codeUnit - 0x41 + 10;
    else if (codeUnit >= 0x61 && codeUnit <= 0x66) digit = codeUnit - 0x61 + 10;
    else throw new Error("invalid Unicode escape");
    value = value * 16 + digit;
  }
  return value;
}

/** @param {number} codePoint */
function utf8CodePointBytes(codePoint) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
