
/** @typedef {import("./FrameDelta.ts").FrameDelta} FrameDelta */
const FRAME_DELTA_VERSION = 1;
/**
 * @param {string} deltaJson
 * @returns {FrameDelta}
 */
export function parseFrameDelta(deltaJson) {
    const parsed = JSON.parse(deltaJson);
    if (!isRecord(parsed)) {
        throw new Error("Invalid frame delta payload (not an object)");
    }
    if (parsed.version !== FRAME_DELTA_VERSION) {
        throw new Error(`Unsupported frame delta version: ${String(parsed.version)}`);
    }
    if (!Array.isArray(parsed.ops)) {
        throw new Error("Invalid frame delta payload (missing ops array)");
    }
    return parsed;
}
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
