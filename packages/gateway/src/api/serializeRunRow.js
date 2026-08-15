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

const CANCELLATION_SOURCE_KINDS = new Set(["signal", "rpc", "cli", "engine"]);

/** @param {Record<string, unknown>} row */
function cancellationSourceFromRow(row) {
  if (typeof row.cancelRequestSource !== "string") return undefined;
  const rawKind = row.cancelRequestSource;
  const legacyTransport = rawKind === "http" || rawKind === "websocket" || rawKind === "gateway";
  const kind = legacyTransport ? "rpc" : rawKind;
  if (!CANCELLATION_SOURCE_KINDS.has(kind)) return undefined;
  const detail =
    typeof row.cancelRequestDetail === "string"
      ? row.cancelRequestDetail
      : legacyTransport
        ? `${rawKind} cancellation request`
        : undefined;
  return {
    kind,
    ...(detail !== undefined ? { detail } : {}),
    ...(typeof row.cancelRequestSignal === "string" ? { signal: row.cancelRequestSignal } : {}),
    ...(Number.isSafeInteger(row.cancelRequestClientPid) && Number(row.cancelRequestClientPid) > 0
      ? { clientPid: Number(row.cancelRequestClientPid) }
      : {}),
    ...(typeof row.cancelRequestId === "string" ? { requestId: row.cancelRequestId } : {}),
    ...(typeof row.cancelRequestClientIdentity === "string" ? { clientIdentity: row.cancelRequestClientIdentity } : {}),
  };
}

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
export function serializeRunRow(row) {
  const normalized = normalizeApiRow(row);
  const cancellationSource = cancellationSourceFromRow(normalized);
  if (cancellationSource) normalized.cancellationSource = cancellationSource;
  let config;
  if (typeof normalized.configJson === "string") {
    try {
      config = /** @type {{ gatewayWorkflowKey?: unknown; gatewaySystem?: unknown; startedBy?: unknown }} */ (
        JSON.parse(normalized.configJson)
      );
    } catch {
      // Malformed run config stays opaque on the wire.
    }
  }
  if (normalized.workflowKey === undefined && typeof config?.gatewayWorkflowKey === "string") {
    normalized.workflowKey = config.gatewayWorkflowKey;
  }
  const startedBy = validStartedBy(config?.startedBy);
  if (startedBy) normalized.startedBy = startedBy;
  // Visibility is fail-closed. New gateway runs persist a boolean stamp;
  // historical or malformed rows are internal until an explicit debug list
  // opts into them. Preserve an already-projected trusted server response
  // (launch/get/list) which carries no configJson.
  normalized.system =
    typeof config?.gatewaySystem === "boolean"
      ? config.gatewaySystem
      : typeof normalized.system === "boolean"
        ? normalized.system
        : true;
  if (normalized.workflowKey === undefined && typeof normalized.workflowName === "string") {
    normalized.workflowKey = normalized.workflowName;
  }
  return /** @type {Row} */ (normalized);
}
