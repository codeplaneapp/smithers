import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { cloneAgentCheckpoint, DEFAULT_AGENT_CHECKPOINT_MAX_BYTES } from "../../src/agent-checkpoint.js";
import {
  NANOCODEX_DEFAULT_MODEL,
  NANOCODEX_LIMITS,
  NANOCODEX_MODELS,
  NANOCODEX_PROTOCOL_NAME,
  NANOCODEX_PROTOCOL_VERSION,
  NANOCODEX_VERSION,
  validateNanocodexStrictJsonValue,
} from "./protocol.js";

export const NANOCODEX_CHECKPOINT_CODEC = "nanocodex.session-snapshot";
export const NANOCODEX_CHECKPOINT_VERSION = 1;
export const NANOCODEX_SNAPSHOT_VERSION = 1;
export const NANOCODEX_POLICY_FINGERPRINT_VERSION = 1;
export const NANOCODEX_TOOL_PROFILE = "nanocodex-stock-0.5.0";

/** @type {readonly import("../../src/AgentCheckpoint.ts").AgentCheckpointFormat[]} */
export const NANOCODEX_CHECKPOINT_FORMATS = Object.freeze([
  Object.freeze({ codec: NANOCODEX_CHECKPOINT_CODEC, versions: Object.freeze([NANOCODEX_CHECKPOINT_VERSION]) }),
]);

/** @type {readonly import("../../src/AgentCheckpoint.ts").AgentCheckpointCapability[]} */
export const NANOCODEX_CHECKPOINT_CAPABILITIES = Object.freeze([
  Object.freeze({
    codec: NANOCODEX_CHECKPOINT_CODEC,
    versions: Object.freeze([NANOCODEX_CHECKPOINT_VERSION]),
    modes: Object.freeze(["resume"]),
  }),
]);

/**
 * Return the canonical, continuation-sensitive stock Nanocodex 0.5.0 policy.
 * Property insertion order is part of the fingerprint version 1 definition.
 *
 * @param {string | null} [instructions]
 * @returns {import("./protocol-types.ts").NanocodexPolicy}
 */
export function createNanocodexPolicy(instructions = null) {
  if (instructions !== null && typeof instructions !== "string") {
    throw new TypeError("Nanocodex policy instructions must be a string or null.");
  }
  if (instructions !== null) assertUnicodeScalarString(instructions);
  return {
    fingerprintVersion: NANOCODEX_POLICY_FINGERPRINT_VERSION,
    instructions,
    tools: {
      profile: NANOCODEX_TOOL_PROFILE,
      codeMode: true,
      mcp: false,
      subagents: false,
    },
  };
}

/**
 * Compute the stable SHA-256 fingerprint of the canonical v1 policy JSON.
 *
 * @param {string | null} [instructions]
 * @returns {`sha256:${string}`}
 */
export function createNanocodexPolicyFingerprint(instructions = null) {
  const canonical = createNanocodexPolicyFingerprintInput(instructions);
  return /** @type {`sha256:${string}`} */ (`sha256:${createHash("sha256").update(canonical).digest("hex")}`);
}

/**
 * Construct the exact UTF-8 bytes hashed by policy-fingerprint version 1.
 * This intentionally does not delegate string escaping to JSON.stringify.
 *
 * @param {string | null} [instructions]
 * @returns {Buffer}
 */
export function createNanocodexPolicyFingerprintInput(instructions = null) {
  if (instructions !== null && typeof instructions !== "string") {
    throw new TypeError("Nanocodex policy instructions must be a string or null.");
  }
  const encodedInstructions = instructions === null ? "null" : encodeJsonScalarString(instructions);
  return Buffer.from(
    `{"fingerprintVersion":1,"instructions":${encodedInstructions},"tools":{"profile":"nanocodex-stock-0.5.0","codeMode":true,"mcp":false,"subagents":false}}`,
    "utf8",
  );
}

/**
 * Construct and size-check a strict Smithers checkpoint from authoritative
 * turn.completed (or recoverable cleanup-failed) data.
 *
 * @param {{
 *   snapshot: import("../../src/AgentCheckpoint.ts").AgentCheckpointJsonObject;
 *   snapshotVersion: number;
 *   canonicalWorkspace: string;
 *   policyFingerprint: string;
 * }} completed
 * @param {number} [maxBytes]
 * @returns {import("./protocol-types.ts").NanocodexCheckpoint}
 */
export function createNanocodexCheckpoint(completed, maxBytes = DEFAULT_AGENT_CHECKPOINT_MAX_BYTES) {
  assertExactObject(completed, ["snapshot", "snapshotVersion", "canonicalWorkspace", "policyFingerprint"], ["model"]);
  const model = completed.model ?? NANOCODEX_DEFAULT_MODEL;
  const checkpoint = {
    codec: NANOCODEX_CHECKPOINT_CODEC,
    version: NANOCODEX_CHECKPOINT_VERSION,
    payload: {
      bridgeProtocolVersion: NANOCODEX_PROTOCOL_VERSION,
      nanocodexVersion: NANOCODEX_VERSION,
      snapshotVersion: completed.snapshotVersion,
      model,
      canonicalWorkspace: completed.canonicalWorkspace,
      policyFingerprint: completed.policyFingerprint,
      nanocodexSnapshot: completed.snapshot,
    },
  };
  return validateNanocodexCheckpoint(checkpoint, {
    mode: "resume",
    canonicalWorkspace: completed.canonicalWorkspace,
    policyFingerprint: completed.policyFingerprint,
    maxBytes,
  });
}

/**
 * Validate, size-check, and clone one exact v1 checkpoint for same-workspace
 * resume. The returned object never retains mutable references to the input.
 *
 * @param {unknown} checkpoint
 * @param {{
 *   mode?: "resume";
 *   canonicalWorkspace: string;
 *   policyFingerprint: string;
 *   maxBytes?: number;
 * }} options
 * @returns {import("./protocol-types.ts").NanocodexCheckpoint}
 */
export function validateNanocodexCheckpoint(checkpoint, options) {
  assertExactObject(options, ["canonicalWorkspace", "policyFingerprint"], ["mode", "maxBytes"]);
  if ((options.mode ?? "resume") !== "resume") {
    fail("Nanocodex checkpoints support resume mode only.");
  }
  assertCanonicalWorkspace(options.canonicalWorkspace);
  assertPolicyFingerprint(options.policyFingerprint);

  assertExactObject(checkpoint, ["codec", "version", "payload"]);
  validateNanocodexStrictJsonValue(checkpoint);
  if (checkpoint.codec !== NANOCODEX_CHECKPOINT_CODEC) {
    fail("Nanocodex checkpoint codec is not supported.");
  }
  if (checkpoint.version !== NANOCODEX_CHECKPOINT_VERSION) {
    fail("Nanocodex checkpoint codec version is not supported.");
  }
  assertExactObject(
    checkpoint.payload,
    [
      "bridgeProtocolVersion",
      "nanocodexVersion",
      "snapshotVersion",
      "canonicalWorkspace",
      "policyFingerprint",
      "nanocodexSnapshot",
    ],
    ["model"],
  );
  if (checkpoint.payload.bridgeProtocolVersion !== NANOCODEX_PROTOCOL_VERSION) {
    fail("Nanocodex checkpoint bridge protocol version is not supported.");
  }
  if (checkpoint.payload.nanocodexVersion !== NANOCODEX_VERSION) {
    fail("Nanocodex checkpoint library version is not supported.");
  }
  if (checkpoint.payload.snapshotVersion !== NANOCODEX_SNAPSHOT_VERSION) {
    fail("Nanocodex checkpoint snapshot version is not supported.");
  }
  if (
    "model" in checkpoint.payload &&
    (typeof checkpoint.payload.model !== "string" || !NANOCODEX_MODELS.includes(checkpoint.payload.model))
  ) {
    fail("Nanocodex checkpoint model is not supported.");
  }
  assertCanonicalWorkspace(checkpoint.payload.canonicalWorkspace);
  if (checkpoint.payload.canonicalWorkspace !== options.canonicalWorkspace) {
    fail("Nanocodex checkpoint workspace does not match the requested canonical workspace.");
  }
  assertPolicyFingerprint(checkpoint.payload.policyFingerprint);
  if (checkpoint.payload.policyFingerprint !== options.policyFingerprint) {
    fail("Nanocodex checkpoint policy does not match the requested policy.");
  }
  if (!isPlainObject(checkpoint.payload.nanocodexSnapshot)) {
    fail("Nanocodex checkpoint snapshot must be a JSON object.");
  }
  assertResumeEnvelopeFits(checkpoint.payload.nanocodexSnapshot, checkpoint.payload.canonicalWorkspace);
  const snapshotBytes = Buffer.byteLength(JSON.stringify(checkpoint.payload.nanocodexSnapshot), "utf8");
  if (snapshotBytes > NANOCODEX_LIMITS.maxSnapshotBytes) {
    fail("Nanocodex checkpoint snapshot exceeds the 15728640-byte protocol ceiling.");
  }

  const cloned = cloneAgentCheckpoint(
    /** @type {import("../../src/AgentCheckpoint.ts").AgentCheckpoint} */ (checkpoint),
    options.maxBytes ?? DEFAULT_AGENT_CHECKPOINT_MAX_BYTES,
  );
  return /** @type {import("./protocol-types.ts").NanocodexCheckpoint} */ (cloned);
}

/**
 * Validate a checkpoint and return an isolated copy of its opaque resume
 * snapshot, ready for `turn.start.data.continuation.snapshot`.
 *
 * @param {unknown} checkpoint
 * @param {{
 *   mode?: "resume";
 *   canonicalWorkspace: string;
 *   policyFingerprint: string;
 *   maxBytes?: number;
 * }} options
 * @returns {import("../../src/AgentCheckpoint.ts").AgentCheckpointJsonObject}
 */
export function getNanocodexResumeSnapshot(checkpoint, options) {
  return validateNanocodexCheckpoint(checkpoint, options).payload.nanocodexSnapshot;
}

/** @param {string} value */
function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail("Nanocodex JSON strings contain an unpaired UTF-16 surrogate.");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail("Nanocodex JSON strings contain an unpaired UTF-16 surrogate.");
    }
  }
}

/** @param {string} value */
function encodeJsonScalarString(value) {
  assertUnicodeScalarString(value);
  let encoded = '"';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      encoded += value[index] + value[index + 1];
      index += 1;
      continue;
    }
    switch (codeUnit) {
      case 0x22:
        encoded += '\\"';
        break;
      case 0x5c:
        encoded += "\\\\";
        break;
      case 0x08:
        encoded += "\\b";
        break;
      case 0x09:
        encoded += "\\t";
        break;
      case 0x0a:
        encoded += "\\n";
        break;
      case 0x0c:
        encoded += "\\f";
        break;
      case 0x0d:
        encoded += "\\r";
        break;
      default:
        encoded += codeUnit <= 0x1f ? `\\u${codeUnit.toString(16).padStart(4, "0")}` : value[index];
    }
  }
  return `${encoded}"`;
}

/** @param {Record<string, unknown>} snapshot @param {string} canonicalWorkspace */
function assertResumeEnvelopeFits(snapshot, canonicalWorkspace) {
  const minimalResume = {
    protocol: NANOCODEX_PROTOCOL_NAME,
    version: NANOCODEX_PROTOCOL_VERSION,
    type: "turn.start",
    commandId: "resume",
    requestId: "resume",
    data: {
      prompt: "r",
      workspace: canonicalWorkspace,
      auth: { mode: "chatgpt", authFile: null },
      transport: { kind: "websocket" },
      options: { instructions: null, model: null, thinking: null, reasoningMode: null, fastMode: null },
      continuation: { mode: "resume", snapshot },
    },
  };
  try {
    validateNanocodexStrictJsonValue(minimalResume);
    if (Buffer.byteLength(JSON.stringify(minimalResume), "utf8") > NANOCODEX_LIMITS.maxInputRecordBytes) {
      fail("Nanocodex checkpoint snapshot cannot fit a minimal resume command.");
    }
  } catch {
    fail("Nanocodex checkpoint snapshot exceeds the protocol resume-structure limits.");
  }
}

/** @param {unknown} value */
function assertCanonicalWorkspace(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    fail("Nanocodex checkpoint workspace must be an absolute canonical path.");
  }
}

/** @param {unknown} value */
function assertPolicyFingerprint(value) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail("Nanocodex checkpoint policy fingerprint is invalid.");
  }
}

/**
 * @param {unknown} value
 * @param {string[]} required
 * @param {string[]} [optional]
 * @returns {asserts value is Record<string, any>}
 */
function assertExactObject(value, required, optional = []) {
  if (!isPlainObject(value)) fail("Nanocodex checkpoint value must be a plain object.");
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.length < required.length ||
    keys.length > allowed.size ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    fail("Nanocodex checkpoint object has an invalid field set.");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("Nanocodex checkpoint object must contain enumerable data properties only.");
    }
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @returns {never} @param {string} message */
function fail(message) {
  throw new TypeError(message);
}
