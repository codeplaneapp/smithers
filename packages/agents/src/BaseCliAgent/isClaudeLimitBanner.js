// Anchored Claude/Fable exit-0 stdout limit banners. Unlike the broad
// QUOTA_PATTERNS classifier (which is meant for surfaced CLI *errors*), this
// matcher only fires on the specific banner phrasings Claude/Fable print as
// ordinary assistant text on a successful (exit 0) run. Gating the banner
// interpreter with this narrow matcher keeps a successful run whose model
// output merely *mentions* rate-limit/quota prose (e.g. "429 rate limit
// exceeded", "too many requests") from being misclassified as a quota error
// and parked. Every string this matches is a strict subset of QUOTA_PATTERNS,
// so reset-time parsing still works at the engine boundary.
const CLAUDE_LIMIT_BANNER_PATTERNS = [
    /\bhit\s+your\s+(usage|session|weekly|daily|monthly|rate)\s+limit\b/i,
    /\bout\s+of\s+usage\s+credits\b/i,
    /\brun\s+\/usage-credits\b/i,
    /\b(usage|session|weekly|daily|monthly)\s+limit\s+reached\b/i,
];

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isClaudeLimitBanner(text) {
    if (!text) return false;
    return CLAUDE_LIMIT_BANNER_PATTERNS.some((re) => re.test(text));
}
