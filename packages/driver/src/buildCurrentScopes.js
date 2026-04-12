/**
 * @param {Record<string, number>} [iterations]
 * @returns {Set<string>}
 */
export function buildCurrentScopes(iterations) {
    const scopes = new Set();
    if (!iterations)
        return scopes;
    const unscopedIters = {};
    for (const [ralphId, iter] of Object.entries(iterations)) {
        if (!ralphId.includes("@@")) {
            unscopedIters[ralphId] = iter;
        }
    }
    for (const ralphId of Object.keys(iterations)) {
        const atIdx = ralphId.indexOf("@@");
        if (atIdx < 0)
            continue;
        const suffix = ralphId.slice(atIdx + 2);
        const rebuiltParts = [];
        for (const part of suffix.split(",")) {
            const eqIdx = part.indexOf("=");
            if (eqIdx < 0)
                continue;
            const ancestorId = part.slice(0, eqIdx);
            const currentIter = unscopedIters[ancestorId];
            rebuiltParts.push(currentIter === undefined ? part : `${ancestorId}=${currentIter}`);
        }
        if (rebuiltParts.length > 0) {
            scopes.add("@@" + rebuiltParts.join(","));
        }
    }
    return scopes;
}
