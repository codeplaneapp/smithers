/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function extractTextFromJsonValue(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        const text = value.map((item) => extractTextFromJsonValue(item) ?? "").join("");
        return text || undefined;
    }
    if (!value || typeof value !== "object")
        return undefined;
    const record = /** @type {Record<string, unknown>} */ (value);
    if (typeof record.text === "string")
        return record.text;
    if (typeof record.content === "string")
        return record.content;
    if (typeof record.output_text === "string")
        return record.output_text;
    if (Array.isArray(record.content)) {
        const text = record.content
            .map((part) => extractTextFromJsonValue(part) ?? "")
            .join("");
        if (text)
            return text;
    }
    if (record.type === "text" && record.part)
        return extractTextFromJsonValue(record.part);
    for (const field of ["response", "message", "result", "output", "data", "item"]) {
        const text = extractTextFromJsonValue(record[field]);
        if (text)
            return text;
    }
    return undefined;
}
