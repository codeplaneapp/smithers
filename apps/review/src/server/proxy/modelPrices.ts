/**
 * The metered proxy's price table. The numbers now live in ONE place —
 * `smithers-orchestrator/scorers` — so the `<Estimate>` component, the spend
 * dashboards, and this runaway brake never drift apart. This module keeps the
 * historical `modelPrices` / `ModelPrice` names the proxy imports.
 */
export type { ModelPrice } from "smithers-orchestrator/scorers";
export { modelTokenPrices as modelPrices } from "smithers-orchestrator/scorers";

// This is intentionally an explicit Anthropic request allowlist, separate
// from the shared reporting lookup's permissive historical suffix matching.
// Adding a priced model is a billing-boundary change and must update this list.
const PRICED_ANTHROPIC_REQUEST_MODELS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

/**
 * Admit exact priced Anthropic ids, an eight-digit dated release, and the
 * explicitly supported 1m context alias. Arbitrary `-premium` / `_preview`
 * prefixes are not equivalent to their cheaper base model for billing.
 */
export function isPricedAnthropicRequestModel(model: string): boolean {
  const normalized = model.toLowerCase();
  for (const base of PRICED_ANTHROPIC_REQUEST_MODELS) {
    if (!normalized.startsWith(base)) continue;
    const suffix = normalized.slice(base.length);
    if (
      suffix === ""
      || suffix === "[1m]"
      || /^-\d{8}(?:\[1m\])?$/.test(suffix)
    ) {
      return true;
    }
  }
  return false;
}
