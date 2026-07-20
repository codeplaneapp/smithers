/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateClaudeMirrorText(text, maxChars) {
    if (typeof text !== "string") {
        return "";
    }
    if (maxChars <= 0 || text.length <= maxChars) {
        return text;
    }
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}… [truncated ${omitted} chars]`;
}
