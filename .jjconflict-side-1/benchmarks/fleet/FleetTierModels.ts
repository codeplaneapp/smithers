/**
 * Claude model ids for each delegation tier. The fleet is Opus-and-weaker only
 * (no Fable-5, no Codex/GPT, no Gemini), so the "strong" ends that the default
 * Fable Sandwich fills are pinned to Opus instead.
 *
 * Maps onto `DelegationChain`'s tier labels: `strong` -> the fable tier (which
 * the chain uses for planning AND review), `smart` -> the opus tier,
 * `implement` -> the sonnet tier, `cheap` -> the haiku tier.
 */
export type FleetTierModels = {
  /** Plans and reviews (the judgment-heavy ends). Opus. */
  strong: string;
  /** General smart-tier work. Opus. */
  smart: string;
  /** The implementation middle of the sandwich. Sonnet. */
  implement: string;
  /** Previews and research probes. Haiku. */
  cheap: string;
};
