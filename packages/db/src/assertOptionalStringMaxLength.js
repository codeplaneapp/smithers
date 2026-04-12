import { assertMaxStringLength } from "./assertMaxStringLength.js";
/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} maxLength
 */
export function assertOptionalStringMaxLength(field, value, maxLength) {
    if (value === undefined || value === null)
        return;
    assertMaxStringLength(field, value, maxLength);
}
