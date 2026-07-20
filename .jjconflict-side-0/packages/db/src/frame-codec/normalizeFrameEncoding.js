
/** @typedef {import("./FrameEncoding.ts").FrameEncoding} FrameEncoding */
/**
 * @param {unknown} value
 * @returns {FrameEncoding}
 */
export function normalizeFrameEncoding(value) {
    if (value === "delta")
        return "delta";
    if (value === "keyframe")
        return "keyframe";
    return "full";
}
