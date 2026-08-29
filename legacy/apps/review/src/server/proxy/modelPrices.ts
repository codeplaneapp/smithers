/**
 * The metered proxy's price table. The numbers now live in ONE place —
 * `smthrs/scorers` — so the `<Estimate>` component, the spend
 * dashboards, and this runaway brake never drift apart. This module keeps the
 * historical `modelPrices` / `ModelPrice` names the proxy imports.
 */
export type { ModelPrice } from "smthrs/scorers";
export { modelTokenPrices as modelPrices } from "smthrs/scorers";
