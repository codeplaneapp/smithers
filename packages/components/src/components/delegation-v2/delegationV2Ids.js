import { createHash } from "node:crypto";

export const GATEWAY_NODE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/;
const SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PREFIX = "trellis";

/**
 * Canonical JSON for protocol identity. Object keys are sorted, array order is
 * retained, and values outside the JSON data model are rejected rather than
 * being silently coerced or omitted.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  /** @type {Set<object>} */
  const ancestors = new Set();

  /** @param {unknown} current @returns {string} */
  function encode(current) {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("canonicalJson only accepts finite numbers");
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    if (typeof current !== "object") {
      throw new TypeError(`canonicalJson cannot encode ${typeof current}`);
    }
    if (ancestors.has(current)) throw new TypeError("canonicalJson cannot encode cyclic values");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const entries = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) throw new TypeError("canonicalJson cannot encode sparse arrays");
          entries.push(encode(current[index]));
        }
        return `[${entries.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("canonicalJson only accepts plain objects and arrays");
      }
      const record = /** @type {Record<string, unknown>} */ (current);
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  return encode(value);
}

/** @param {unknown} value @returns {string} */
export function hashStableValue(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** @param {string} nodeId */
export function isGatewaySafeNodeId(nodeId) {
  return GATEWAY_NODE_ID_PATTERN.test(nodeId);
}

/** @param {unknown} value @param {string} name @param {number} [maxLength] */
function assertSegment(value, name, maxLength = 32) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || !SEGMENT_PATTERN.test(value)) {
    throw new TypeError(`${name} must match ${SEGMENT_PATTERN} and be at most ${maxLength} characters`);
  }
  return value;
}

/** @param {unknown} value */
function assertGeneration(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("generation must be a non-negative safe integer");
  }
  return Number(value);
}

/** @param {unknown} value @param {string} name */
function assertInvocationKey(value, name = "invocationKey") {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new TypeError(`${name} must be a non-empty string of at most 2048 characters`);
  }
  return value;
}

/** @param {string} raw */
function readableHint(raw) {
  const hint = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return hint || "node";
}

/** @param {string} nodeId */
function checked(nodeId) {
  if (!isGatewaySafeNodeId(nodeId)) throw new Error(`derived node id is not gateway-safe: ${nodeId}`);
  return nodeId;
}

/**
 * Immutable physical ID for one author turn or repair turn.
 *
 * @param {{prefix?: string, invocationKey: string, generation: number, phase: string}} options
 */
export function turnNodeId({ prefix = DEFAULT_PREFIX, invocationKey, generation, phase }) {
  const safePrefix = assertSegment(prefix, "prefix", 24);
  const key = assertInvocationKey(invocationKey);
  const safeGeneration = assertGeneration(generation);
  const safePhase = assertSegment(phase, "phase", 24);
  const digest = hashStableValue({
    type: "turn",
    prefix: safePrefix,
    invocationKey: key,
    generation: safeGeneration,
    phase: safePhase,
  });
  return checked(`${safePrefix}:turn:g${safeGeneration}:${safePhase}:${digest.slice(0, 24)}`);
}

/**
 * Physical ID for one node compiled from a persisted program. Identity is
 * independent of sibling position and includes the complete program digest.
 *
 * @param {{prefix?: string, invocationKey: string, generation: number, programDigest: string, localId: string, phase: string}} options
 */
export function programNodeId({ prefix = DEFAULT_PREFIX, invocationKey, generation, programDigest, localId, phase }) {
  const safePrefix = assertSegment(prefix, "prefix", 24);
  const key = assertInvocationKey(invocationKey);
  const safeGeneration = assertGeneration(generation);
  if (typeof programDigest !== "string" || !DIGEST_PATTERN.test(programDigest)) {
    throw new TypeError("programDigest must be a lowercase sha256 hex digest");
  }
  const safeLocalId = assertSegment(localId, "localId", 48);
  const safePhase = assertSegment(phase, "phase", 24);
  const digest = hashStableValue({
    type: "program-node",
    prefix: safePrefix,
    invocationKey: key,
    generation: safeGeneration,
    programDigest,
    localId: safeLocalId,
    phase: safePhase,
  });
  return checked(`${safePrefix}:node:${readableHint(safeLocalId)}:${safePhase}:${digest.slice(0, 24)}`);
}

/** @param {{prefix?: string, invocationKey: string}} options */
export function invocationOutcomeNodeId({ prefix = DEFAULT_PREFIX, invocationKey }) {
  const safePrefix = assertSegment(prefix, "prefix", 24);
  const key = assertInvocationKey(invocationKey);
  const digest = hashStableValue({ type: "invocation-outcome", prefix: safePrefix, invocationKey: key });
  return checked(`${safePrefix}:outcome:${readableHint(key)}:${digest.slice(0, 24)}`);
}
