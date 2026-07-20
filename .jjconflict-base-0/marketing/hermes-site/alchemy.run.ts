/**
 * Alchemy infrastructure-as-code for the Smithers × Hermes marketing site.
 *
 * Deploys the self-contained page (index.html) to Cloudflare as a static-assets
 * site bound to hermes.smithers.sh. No server logic: with no entrypoint, Alchemy
 * generates a default Worker and Cloudflare's static-assets layer serves
 * index.html directly. Pattern mirrors the gil microsite.
 *
 * Deploy:   npm run deploy      (binds the custom domain)
 * Destroy:  npm run destroy
 *
 * NOTE: run with `node alchemy.run.ts [--destroy]` (node strips TS types). Bun
 * segfaults running the Alchemy entrypoint on this machine, so the `alchemy` CLI
 * (which spawns under bun) hangs. Running with node directly is the reliable path.
 *
 * Required env: CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID if multi-account)
 * and ALCHEMY_PASSWORD for the encrypted state. The smithers.sh zone must live in
 * that Cloudflare account (it already hosts ui-preview.smithers.sh).
 */
import alchemy from "alchemy";
import { Website } from "alchemy/cloudflare";

const app = await alchemy("smithers-hermes-site");

// Allow a workers.dev dry run (SITE_DOMAIN="") before the real domain cutover.
const domain = process.env.SITE_DOMAIN?.trim() ?? "hermes.smithers.sh";

export const site = await Website("smithers-hermes-site", {
  // Explicit, short Worker name (auto-generated names overflow the 63-char limit).
  name: "smithers-hermes-site",
  // Adopt an existing same-named Worker instead of erroring if state was reset.
  adopt: true,
  // No entrypoint → Alchemy generates a default Worker; static-assets serves
  // dist/index.html at "/".
  build: { command: "node build.mjs" },
  assets: "dist",
  spa: false,
  url: false,
  compatibilityDate: "2025-05-01",
  ...(domain ? { domains: [domain] } : {}),
});

console.log(`deployed: ${domain ? `https://${domain}` : site.url}`);

await app.finalize();
