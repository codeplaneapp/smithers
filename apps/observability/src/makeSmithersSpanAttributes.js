import { smithersSpanAttributeAliases } from "./_smithersSpanAttributeAliases.js";
/**
 * @typedef {Readonly<Record<string, unknown>>} SmithersSpanAttributesInput
 */

/**
 * @param {SmithersSpanAttributesInput} [attributes]
 * @returns {Record<string, unknown>}
 */
export function makeSmithersSpanAttributes(attributes = {}) {
    const spanAttributes = {};
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined) {
            continue;
        }
        const nextKey = key.startsWith("smithers.") ? key : (smithersSpanAttributeAliases[key] ?? key);
        spanAttributes[nextKey] = value;
    }
    return spanAttributes;
}
