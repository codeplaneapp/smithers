const UTF8_ENCODER = new TextEncoder();

/** @param {unknown} value */
function serializedByteLength(value) {
    return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength;
}

/**
 * Conservatively cap serialized recall rows without choosing a model-specific
 * tokenizer. A byte-level tokenizer cannot emit more tokens than the UTF-8
 * byte count, so this ceiling is safe for dense Unicode as well as ASCII.
 *
 * @param {Array<{ text?: unknown; bank?: unknown }>} results
 * @param {number | undefined} maxTokens
 * @returns {Array<{ bank?: string; text: string }>}
 */
export function capMemoryRecallResults(results, maxTokens) {
    const normalized = results.flatMap((result) => typeof result.text === "string" && result.text.length > 0
        ? [{ ...(typeof result.bank === "string" ? { bank: result.bank } : {}), text: result.text }]
        : []);
    if (maxTokens === undefined) {
        return normalized;
    }
    const byteBudget = Math.max(0, Math.floor(maxTokens));
    /** @type {Array<{ bank?: string; text: string }>} */
    const selected = [];
    for (const result of normalized) {
        if (serializedByteLength([...selected, result]) <= byteBudget) {
            selected.push(result);
            continue;
        }
        const characters = [...result.text];
        let low = 0;
        let high = characters.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            const candidate = { ...result, text: characters.slice(0, middle).join("") };
            if (serializedByteLength([...selected, candidate]) <= byteBudget) {
                low = middle;
            }
            else {
                high = middle - 1;
            }
        }
        if (low > 0) {
            selected.push({ ...result, text: characters.slice(0, low).join("") });
        }
        break;
    }
    return selected;
}
