import { createHash } from "node:crypto";

/** Maximum encoded checkpoint size accepted by default (16 MiB). */
export const DEFAULT_AGENT_CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Hash the semantic checkpoint production and consumption declarations.
 * Declaration order, repeated entries, and repeated values are ignored.
 *
 * @param {{ checkpointFormats?: readonly import("./AgentCheckpoint.ts").AgentCheckpointFormat[]; checkpointCapabilities?: readonly import("./AgentCheckpoint.ts").AgentCheckpointCapability[] } | null | undefined} agent
 * @returns {string}
 */
export function hashAgentCheckpointCapabilities(agent) {
  const produced = new Set();
  if (Array.isArray(agent?.checkpointFormats)) {
    for (const format of agent.checkpointFormats) {
      if (!format || typeof format.codec !== "string" || !Array.isArray(format.versions)) continue;
      for (const version of format.versions) {
        if (Number.isSafeInteger(version) && version > 0) produced.add(JSON.stringify([format.codec, version]));
      }
    }
  }

  const consumed = new Set();
  if (Array.isArray(agent?.checkpointCapabilities)) {
    for (const capability of agent.checkpointCapabilities) {
      if (
        !capability ||
        typeof capability.codec !== "string" ||
        !Array.isArray(capability.versions) ||
        !Array.isArray(capability.modes)
      ) {
        continue;
      }
      for (const version of capability.versions) {
        if (!Number.isSafeInteger(version) || version <= 0) continue;
        for (const mode of capability.modes) {
          if (mode === "resume" || mode === "fork") {
            consumed.add(JSON.stringify([capability.codec, version, mode]));
          }
        }
      }
    }
  }

  const canonical = JSON.stringify({
    produced: [...produced].sort(),
    consumed: [...consumed].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Test whether an agent declares support for a checkpoint version and use.
 * @param {{ checkpointCapabilities?: readonly import("./AgentCheckpoint.ts").AgentCheckpointCapability[] } | null | undefined} agent
 * @param {{ codec: string; version: number }} checkpoint
 * @param {import("./AgentCheckpoint.ts").AgentCheckpointMode} mode
 */
export function agentSupportsCheckpoint(agent, checkpoint, mode) {
  return (
    Array.isArray(agent?.checkpointCapabilities) &&
    agent.checkpointCapabilities.some(
      (capability) =>
        capability?.codec === checkpoint.codec &&
        Array.isArray(capability.versions) &&
        capability.versions.includes(checkpoint.version) &&
        Array.isArray(capability.modes) &&
        capability.modes.includes(mode),
    )
  );
}

/**
 * Test whether an agent declares that it can produce a checkpoint format.
 * Production is intentionally independent from resume and fork consumption.
 * @param {{ checkpointFormats?: readonly import("./AgentCheckpoint.ts").AgentCheckpointFormat[] } | null | undefined} agent
 * @param {{ codec: string; version: number }} checkpoint
 */
export function agentProducesCheckpoint(agent, checkpoint) {
  return (
    Array.isArray(agent?.checkpointFormats) &&
    agent.checkpointFormats.some(
      (format) =>
        format?.codec === checkpoint.codec &&
        Array.isArray(format.versions) &&
        format.versions.includes(checkpoint.version),
    )
  );
}

/**
 * Validate, serialize, and clone an agent checkpoint.
 *
 * The JSON walk is intentionally stricter than JSON.stringify: values that
 * JSON.stringify would silently omit or coerce are rejected.
 *
 * @param {import("./AgentCheckpoint.ts").AgentCheckpoint} checkpoint
 * @param {number} [maxBytes]
 * @returns {import("./AgentCheckpoint.ts").AgentCheckpoint}
 */
export function cloneAgentCheckpoint(checkpoint, maxBytes = DEFAULT_AGENT_CHECKPOINT_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("Agent checkpoint maxBytes must be a positive safe integer.");
  }
  if (maxBytes > DEFAULT_AGENT_CHECKPOINT_MAX_BYTES) {
    throw new RangeError(
      `Agent checkpoint maxBytes cannot exceed the ${DEFAULT_AGENT_CHECKPOINT_MAX_BYTES}-byte system ceiling.`,
    );
  }
  if (!isPlainObject(checkpoint)) {
    throw new TypeError("Agent checkpoint must be a plain object.");
  }
  const envelopeKeys = Reflect.ownKeys(checkpoint);
  if (
    envelopeKeys.length !== 3 ||
    !["codec", "version", "payload"].every((key) => envelopeKeys.includes(key)) ||
    envelopeKeys.some((key) => {
      const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(checkpoint, key) : undefined;
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) {
    throw new TypeError("Agent checkpoint must contain exactly codec, version, and payload data properties.");
  }
  const codec = Object.getOwnPropertyDescriptor(checkpoint, "codec").value;
  const version = Object.getOwnPropertyDescriptor(checkpoint, "version").value;
  const payload = Object.getOwnPropertyDescriptor(checkpoint, "payload").value;
  if (typeof codec !== "string" || codec.length === 0) {
    throw new TypeError("Agent checkpoint codec must be a non-empty string.");
  }
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TypeError("Agent checkpoint version must be a positive safe integer.");
  }
  assertJsonValue(payload, "$.payload", new Set());

  const json = JSON.stringify(checkpoint);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > maxBytes) {
    throw new RangeError(`Agent checkpoint exceeds ${maxBytes} bytes (received ${byteLength}).`);
  }
  return JSON.parse(json);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<object>} ancestors
 */
function assertJsonValue(value, path, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Agent checkpoint contains a non-finite number at ${path}.`);
    if (Object.is(value, -0)) throw new TypeError(`Agent checkpoint contains negative zero at ${path}.`);
    return;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`Agent checkpoint contains a non-JSON value at ${path}.`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Agent checkpoint contains an unsupported value at ${path}.`);
  }
  if (ancestors.has(value)) throw new TypeError(`Agent checkpoint contains a cycle at ${path}.`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)))
    ) {
      throw new TypeError(`Agent checkpoint contains non-JSON array properties at ${path}.`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`Agent checkpoint contains a sparse or accessor array entry at ${path}[${index}].`);
      }
      assertJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
    }
  } else {
    if (!isPlainObject(value)) throw new TypeError(`Agent checkpoint contains a non-plain object at ${path}.`);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`Agent checkpoint contains a symbol-keyed property at ${path}.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`Agent checkpoint contains a non-enumerable or accessor property at ${path}.${key}.`);
      }
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}
