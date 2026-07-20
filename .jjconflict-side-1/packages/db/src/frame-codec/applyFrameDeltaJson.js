import { applyFrameDelta } from "./applyFrameDelta.js";
import { parseFrameDelta } from "./parseFrameDelta.js";
/**
 * @param {string} previousXmlJson
 * @param {string} deltaJson
 * @returns {string}
 */
export function applyFrameDeltaJson(previousXmlJson, deltaJson) {
    return applyFrameDelta(previousXmlJson, parseFrameDelta(deltaJson));
}
