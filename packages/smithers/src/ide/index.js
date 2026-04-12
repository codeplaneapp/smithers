// @smithers-type-exports-begin
/** @typedef {import("./index.ts").SmithersIdeAskUserResult} SmithersIdeAskUserResult */
/** @typedef {import("./index.ts").SmithersIdeCommandBaseResult} SmithersIdeCommandBaseResult */
/** @typedef {import("./index.ts").SmithersIdeOpenDiffResult} SmithersIdeOpenDiffResult */
/** @typedef {import("./index.ts").SmithersIdeOpenFileResult} SmithersIdeOpenFileResult */
/** @typedef {import("./index.ts").SmithersIdeOpenWebviewResult} SmithersIdeOpenWebviewResult */
/** @typedef {import("./index.ts").SmithersIdeOverlayOptions} SmithersIdeOverlayOptions */
/** @typedef {import("./index.ts").SmithersIdeOverlayResult} SmithersIdeOverlayResult */
/** @typedef {import("./index.ts").SmithersIdeOverlayType} SmithersIdeOverlayType */
/** @typedef {import("./index.ts").SmithersIdeResolvedConfig} SmithersIdeResolvedConfig */
/** @typedef {import("./index.ts").SmithersIdeRunTerminalResult} SmithersIdeRunTerminalResult */
/** @typedef {import("./index.ts").SmithersIdeServiceApi} SmithersIdeServiceApi */
// @smithers-type-exports-end

import { Effect } from "effect";
import { createSmithersIdeService, createSmithersIdeLayer, detectSmithersIdeAvailabilityEffect, SmithersIdeService, } from "./SmithersIdeService.js";
import { createSmithersIdeCli, SMITHERS_IDE_TOOL_NAMES } from "./tools.js";
/** @typedef {import("./SmithersIdeService.ts").SmithersIdeAvailability} SmithersIdeAvailability */
/** @typedef {import("./SmithersIdeService.ts").SmithersIdeServiceConfig} SmithersIdeServiceConfig */

export { askUser, createSmithersIdeLayer, createSmithersIdeService, detectSmithersIdeAvailabilityEffect, openDiff, openFile, openWebview, runTerminal, showOverlay, SmithersIdeService, } from "./SmithersIdeService.js";
export { createSmithersIdeCli, SMITHERS_IDE_TOOL_NAMES, } from "./tools.js";
/**
 * @param {SmithersIdeServiceConfig} [config]
 */
export function isSmithersIdeAvailable(config = {}) {
    return getSmithersIdeAvailability(config).then((availability) => availability.available);
}
/**
 * @param {SmithersIdeServiceConfig} [config]
 * @returns {Promise<SmithersIdeAvailability>}
 */
export async function getSmithersIdeAvailability(config = {}) {
    return Effect.runPromise(detectSmithersIdeAvailabilityEffect(config));
}
/**
 * @param {SmithersIdeServiceConfig} [config]
 */
export async function createAvailableSmithersIdeCli(config = {}) {
    const availability = await getSmithersIdeAvailability(config);
    return availability.available ? createSmithersIdeCli(config) : null;
}
