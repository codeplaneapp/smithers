
/** @typedef {import("./FrameDelta.ts").FrameDelta} FrameDelta */
/**
 * @param {FrameDelta} delta
 * @returns {string}
 */
export function serializeFrameDelta(delta) {
    return JSON.stringify(delta);
}
