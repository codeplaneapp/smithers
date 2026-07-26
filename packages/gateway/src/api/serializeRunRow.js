import { normalizeApiRow } from "./normalizeApiRow.js";

/** @param {unknown} value */
function validStartedBy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = /** @type {Record<string, unknown>} */ (value);
  const known = ["harness", "sessionId", "prompt", "detected"];
  if (Object.keys(source).some((key) => !known.includes(key))) return undefined;
  if (["harness", "sessionId", "prompt"].some((key) => source[key] !== undefined && typeof source[key] !== "string"))
    return undefined;
  if (source.detected !== undefined && source.detected !== true) return undefined;
  const harness = typeof source.harness === "string" ? source.harness : undefined;
  const sessionId = typeof source.sessionId === "string" ? source.sessionId : undefined;
  const prompt = typeof source.prompt === "string" ? source.prompt : undefined;
  if (!harness && !sessionId && prompt === undefined) return undefined;
  if (source.detected === true && !harness && !sessionId) return undefined;
  return {
    ...(harness ? { harness } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(source.detected === true ? { detected: true } : {}),
  };
}

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeRunRow(row) {
  const normalized = normalizeApiRow(row);
  let config;
  if (typeof normalized.configJson === "string") {
    try {
      config = /** @type {{ gatewayWorkflowKey?: unknown; startedBy?: unknown }} */ (JSON.parse(normalized.configJson));
    } catch {
      // Malformed run config stays opaque on the wire.
    }
  }
  if (normalized.workflowKey === undefined && typeof config?.gatewayWorkflowKey === "string") {
    normalized.workflowKey = config.gatewayWorkflowKey;
  }
  const startedBy = validStartedBy(config?.startedBy);
  if (startedBy) normalized.startedBy = startedBy;
  if (normalized.workflowKey === undefined && typeof normalized.workflowName === "string") {
    normalized.workflowKey = normalized.workflowName;
  }
  return /** @type {Row} */ (normalized);
}
