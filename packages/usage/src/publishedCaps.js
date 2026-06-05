/**
 * Published daily request caps for Google providers, keyed by tier. Google does
 * not expose a live "remaining quota" surface to a personal-login or API-key
 * client, so any usage estimate must subtract local request counts from these
 * documented caps. The numbers move (and the personal Code Assist tiers in the
 * Gemini CLI stop serving 2026-06-18), so they live here as data, not logic.
 *
 * @type {Record<string, { label: string; requestsPerDay: number; rpm?: number }>}
 */
export const PUBLISHED_CAPS = {
    "code-assist-free": { label: "Code Assist (free)", requestsPerDay: 1000, rpm: 60 },
    "ai-pro": { label: "Google AI Pro", requestsPerDay: 1500 },
    "ai-ultra": { label: "Google AI Ultra", requestsPerDay: 2000 },
    "gemini-api-free": { label: "Gemini API (free tier)", requestsPerDay: 250 },
    "code-assist-standard": { label: "Code Assist Standard", requestsPerDay: 1500 },
    "code-assist-enterprise": { label: "Code Assist Enterprise", requestsPerDay: 2000 },
};

/**
 * Looks up a published cap by tier id. Returns `undefined` for unknown tiers so
 * the caller can degrade to "unknown" rather than invent a number.
 *
 * @param {string | undefined} tier
 * @returns {{ label: string; requestsPerDay: number; rpm?: number } | undefined}
 */
export function publishedCapForTier(tier) {
    if (!tier) return undefined;
    return PUBLISHED_CAPS[tier];
}
