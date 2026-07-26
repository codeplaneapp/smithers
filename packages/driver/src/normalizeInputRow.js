/**
 * @param {unknown} input
 * @returns {unknown}
 */
export function normalizeInputRow(input) {
  if (!input || typeof input !== "object") return input;
  const inputObj = /** @type {Record<string, unknown>} */ (input);
  if (!("payload" in inputObj)) {
    if (!("runId" in inputObj)) return input;
    const { runId: _runId, ...rest } = inputObj;
    return rest;
  }
  const keys = Object.keys(inputObj);
  const payloadOnly = keys.every((key) => key === "runId" || key === "payload");
  if (!payloadOnly) return input;
  const payload = inputObj.payload;
  if (payload == null) return {};
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}
