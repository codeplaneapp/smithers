/**
 * @typedef {{ value: unknown; applied: boolean; ruleIds: string[] }} RedactionResult
 */

/** @type {Array<{ id: string; pattern: RegExp; replace: string }>} */
const rules = [
    {
        id: "api-key",
        pattern: /\b(?:sk|pk)_[A-Za-z0-9_-]{8,}\b/g,
        replace: "[REDACTED_API_KEY]",
    },
    {
        id: "bearer-token",
        pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
        replace: "Bearer [REDACTED_TOKEN]",
    },
    {
        id: "auth-header",
        pattern: /"authorization"\s*:\s*"[^"]+"/gi,
        replace: '"authorization":"[REDACTED]"',
    },
    {
        id: "cookie-header",
        pattern: /"cookie"\s*:\s*"[^"]+"/gi,
        replace: '"cookie":"[REDACTED]"',
    },
    {
        id: "secret-ish",
        pattern: /\b(?:api[_-]?key|token|secret|password)=([^\s"']+)/gi,
        replace: "",
    },
];

/**
 * @param {unknown} value
 * @returns {RedactionResult}
 */
export function redactValue(value) {
    const input = typeof value === "string" ? value : JSON.stringify(value ?? null);
    let next = input;
    /** @type {Set<string>} */
    const applied = new Set();
    for (const rule of rules) {
        next = next.replace(rule.pattern, (match) => {
            applied.add(rule.id);
            if (rule.id === "secret-ish") {
                const idx = match.indexOf("=");
                return `${match.slice(0, idx + 1)}[REDACTED_SECRET]`;
            }
            return rule.replace;
        });
    }
    if (applied.size === 0) return { value, applied: false, ruleIds: [] };
    if (typeof value === "string") {
        return { value: next, applied: true, ruleIds: [...applied] };
    }
    try {
        return { value: JSON.parse(next), applied: true, ruleIds: [...applied] };
    } catch {
        return { value: next, applied: true, ruleIds: [...applied] };
    }
}
