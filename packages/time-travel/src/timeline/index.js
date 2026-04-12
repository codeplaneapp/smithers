import { Effect } from "effect";
import { buildTimeline as buildTimelineEffect } from "./buildTimelineEffect.js";
import { buildTimelineTree as buildTimelineTreeEffect } from "./buildTimelineTreeEffect.js";
export { formatTimelineForTui } from "./formatTimelineForTui.js";
export { formatTimelineAsJson } from "./formatTimelineAsJson.js";
export { buildTimelineEffect, buildTimelineTreeEffect, };
/**
 * @param {Parameters<typeof buildTimelineEffect>} ...args
 */
export function buildTimeline(...args) {
    return Effect.runPromise(buildTimelineEffect(...args));
}
/**
 * @param {Parameters<typeof buildTimelineTreeEffect>} ...args
 */
export function buildTimelineTree(...args) {
    return Effect.runPromise(buildTimelineTreeEffect(...args));
}
