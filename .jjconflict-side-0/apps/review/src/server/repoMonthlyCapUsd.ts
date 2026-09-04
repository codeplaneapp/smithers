/**
 * Ceiling on a repo's monthly Anthropic spend. The plan buys prs_per_month
 * reviews each capped at spend_cap_usd, so that product is the most a repo can
 * legitimately spend in a calendar month. Bounding total spend here — not just
 * per session — stops re-minted sessions (which reset the per-session cap back
 * to zero) from driving unbounded spend on an already-reviewed PR.
 */
export function repoMonthlyCapUsd(registration: { prs_per_month: number; spend_cap_usd: number }): number {
  return registration.prs_per_month * registration.spend_cap_usd;
}
