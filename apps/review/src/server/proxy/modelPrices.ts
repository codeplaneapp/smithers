/**
 * The metered proxy's price table. The numbers now live in ONE place —
 * `smithers-orchestrator/scorers` — so the `<Estimate>` component, the spend
 * dashboards, and this runaway brake never drift apart. This module keeps the
 * historical `modelPrices` / `ModelPrice` names the proxy imports.
 */
export type { ModelPrice } from "smithers-orchestrator/scorers";
export { modelTokenPrices as modelPrices } from "smithers-orchestrator/scorers";
