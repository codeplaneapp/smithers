/**
 * Alchemy infrastructure-as-code for smithers.sh.
 *
 * The whole site is static `astro build` output in dist/: the landing page,
 * /download, /demo, and the Starlight docs under /docs. An assets-only
 * Website serves smithers.sh as a custom domain; the zone lives on this
 * Cloudflare account (same convention as apps/bug-worker and apps/status-site).
 * Mirrors wrangler.jsonc, including its 404 handling; that file stays the
 * deploy of record until the first Alchemy deploy adopts the resources.
 *
 * Deploy:   CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... pnpm -C apps/site deploy
 * Destroy:  pnpm -C apps/site destroy
 *
 * Optional env: SMITHERS_SITE_DOMAIN (preview deploys, default smithers.sh),
 * CLOUDFLARE_SMITHERS_ZONE_ID (alchemy resolves the zone from the domain when
 * omitted).
 */
import alchemy from "alchemy";
import { Website } from "alchemy/cloudflare";

const domain = process.env.SMITHERS_SITE_DOMAIN?.trim() || "smithers.sh";
const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined;

const app = await alchemy("smithers-site");

export const site = await Website("smithers-site", {
  build: { command: "pnpm run build" },
  assets: {
    directory: "dist",
    not_found_handling: "404-page",
  },
  adopt: true,
  domains: [{ domainName: domain, ...(zoneId ? { zoneId } : {}), adopt: true }],
});

console.log(`smithers.sh deployed -> https://${domain} (${site.url ?? "no workers.dev url"})`);

await app.finalize();
