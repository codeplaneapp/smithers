/**
 * Extract the first balanced JSON object from text.
 *
 * @param {string} str
 * @returns {string | null}
 */
export function extractBalancedJson(str) {
    const start = str.indexOf("{");
    if (start === -1)
        return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < str.length; i++) {
        const c = str[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (c === "\\") {
            escape = true;
            continue;
        }
        if (c === '"' && !escape) {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (c === "{")
            depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) {
                return str.slice(start, i + 1);
            }
        }
    }
    return null;
}

/**
 * Extract the last balanced JSON object from text.
 *
 * @param {string} str
 * @returns {string | null}
 */
export function extractLastBalancedJson(str) {
    let bestJson = null;
    let bestEnd = -1;
    let pos = str.indexOf("{");
    while (pos >= 0) {
        const json = extractBalancedJson(str.slice(pos));
        if (json !== null) {
            const end = pos + json.length;
            if (end > bestEnd) {
                bestJson = json;
                bestEnd = end;
            }
        }
        pos = str.indexOf("{", pos + 1);
    }
    return bestJson;
}
