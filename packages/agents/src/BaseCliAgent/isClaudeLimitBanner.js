// Whole-line Claude/Fable exit-0 stdout limit banners. Unlike the broad
// QUOTA_PATTERNS classifier (which is meant for surfaced CLI *errors*), this
// matcher only fires on the specific banner phrasings Claude/Fable print as
// ordinary assistant text on a successful (exit 0) run. Gating the banner
// interpreter with this narrow matcher keeps a successful run whose model
// output merely *mentions* rate-limit/quota prose (e.g. "hit your daily limit",
// "usage limit reached") from being misclassified as a quota error and parked.
// Every string this matches is a strict subset of QUOTA_PATTERNS, so reset-time
// parsing still works at the engine boundary.
const CLAUDE_LIMIT_BANNER_PATTERNS = [
  /^You've hit your session limit\s+\u00b7\s+resets\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\s+\([^)]+\)\.?$/i,
  /^You're out of usage credits\. Run \/usage-credits to keep using .+$/i,
  /^Claude usage limit reached\. Your limit will reset at \d{1,2}(?::\d{2})?\s*(?:am|pm)\s+\([^)]+\)\.?$/i,
];

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isClaudeLimitBanner(text) {
  if (!text) return false;
  const trimmed = text.trim();
  return CLAUDE_LIMIT_BANNER_PATTERNS.some((re) => re.test(trimmed));
}
