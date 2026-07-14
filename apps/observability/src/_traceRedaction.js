/**
 * @typedef {{ value: unknown; applied: boolean; ruleIds: string[] }} RedactionResult
 */

/** @type {Array<{ id: string; pattern: RegExp; replace?: string }>} */
const rules = [
    {
        id: "api-key",
        // Covers Stripe-style `sk_`/`pk_` AND the hyphenated provider keys
        // Smithers actually drives: OpenAI `sk-…`/`sk-proj-…` and Anthropic
        // `sk-ant-api03-…`. The separator after sk/pk may be `-` or `_`, and the
        // body may contain further `-`/`_` segments (namespaces like `proj-`,
        // `ant-`, `api03-`).
        pattern: /\b(?:sk|pk)[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g,
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
    },
    {
        id: "cookie-header",
        pattern: /"cookie"\s*:\s*"[^"]+"/gi,
    },
    {
        id: "secret-ish",
        // Negative lookbehind (not `\b`) so an underscore-joined prefix like
        // `ANTHROPIC_API_KEY=` still matches: `_` is a word char, so `\bapi`
        // never fired after it, leaking env-style key dumps.
        pattern: /(?<![A-Za-z0-9])(?:api[_-]?key|token|secret|password)=([^\s"']+)/gi,
        // No `replace` field: redactValue special-cases this rule by id and
        // rewrites the captured value itself, so a top-level replace is never read.
    },
];

const sensitiveKeySuffixes = [
    "authorization",
    "cookie",
    "apikey",
    "token",
    "password",
    "secret",
];

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
    const canonicalKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    return sensitiveKeySuffixes.some((suffix) => canonicalKey.endsWith(suffix));
}

/**
 * @param {unknown} value
 * @param {Set<string>} applied
 * @returns {unknown}
 */
function redactStructuredFields(value, applied) {
    if (Array.isArray(value)) {
        let next = value;
        for (let index = 0; index < value.length; index++) {
            const redacted = redactStructuredFields(value[index], applied);
            if (redacted === value[index]) continue;
            if (next === value) next = [...value];
            next[index] = redacted;
        }
        return next;
    }
    if (value === null || typeof value !== "object") return value;

    const record = /** @type {Record<string, unknown>} */ (value);
    let next = record;
    for (const [key, fieldValue] of Object.entries(record)) {
        let redacted = fieldValue;
        if (isSensitiveKey(key)) {
            redacted = "[REDACTED]";
            applied.add("sensitive-field");
        } else {
            redacted = redactStructuredFields(fieldValue, applied);
        }
        if (redacted === fieldValue) continue;
        if (next === record) next = Object.fromEntries(Object.entries(record));
        next[key] = redacted;
    }
    return next;
}

/**
 * @param {unknown} value
 * @returns {RedactionResult}
 */
export function redactValue(value) {
    /** @type {Set<string>} */
    const applied = new Set();
    const structured = redactStructuredFields(value, applied);
    const input = typeof structured === "string" ? structured : JSON.stringify(structured ?? null);
    let next = input;
    for (const rule of rules) {
        next = next.replace(rule.pattern, (match) => {
            applied.add(rule.id);
            if (rule.id === "secret-ish") {
                const idx = match.indexOf("=");
                return `${match.slice(0, idx + 1)}[REDACTED_SECRET]`;
            }
            if (rule.id === "auth-header" || rule.id === "cookie-header") {
                const idx = match.indexOf(":");
                return `${match.slice(0, idx + 1)}"[REDACTED]"`;
            }
            return rule.replace ?? "[REDACTED]";
        });
    }
    if (applied.size === 0) return { value, applied: false, ruleIds: [] };
    if (typeof structured === "string") {
        return { value: next, applied: true, ruleIds: [...applied] };
    }
    try {
        return { value: JSON.parse(next), applied: true, ruleIds: [...applied] };
    } catch {
        return { value: next, applied: true, ruleIds: [...applied] };
    }
}
