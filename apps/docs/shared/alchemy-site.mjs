// @ts-check
/**
 * alchemy-site.mjs
 *
 * The Alchemy deploy behind every per-package docs site, mirroring
 * apps/site/alchemy.run.ts: an assets-only Cloudflare Website serving the
 * static astro build in dist/ as <slug>.smithers.sh, adopting existing
 * resources, with the zone resolved from the domain unless
 * CLOUDFLARE_SMITHERS_ZONE_ID pins it.
 *
 * A generated apps/docs/<slug>/alchemy.run.ts is one call:
 *
 *   import { deployDocsSite } from "@smithers/docs-shared/alchemy-site"
 *   export const site = await deployDocsSite({ slug: "flow" })
 *
 * Deploy one site:
 *
 *   CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... pnpm -C apps/docs/<slug> deploy
 *
 * Optional env: <SLUG>_SITE_DOMAIN (preview deploys; the slug uppercased
 * with dashes as underscores, e.g. PLATFORM_NODE_SITE_DOMAIN) and
 * CLOUDFLARE_SMITHERS_ZONE_ID.
 */
import alchemy from "alchemy"
import { Website } from "alchemy/cloudflare"

/**
 * Deploys (or destroys, under `alchemy destroy`) one docs site's Cloudflare
 * Website and prints the URL it serves. Returns the Website resource.
 */
export async function deployDocsSite({ slug }) {
  const envDomain = `${slug.toUpperCase().replace(/-/g, "_")}_SITE_DOMAIN`
  const domain = process.env[envDomain]?.trim() || `${slug}.smithers.sh`
  const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined

  const app = await alchemy(`smithers-docs-${slug}`)

  const site = await Website(`smithers-docs-${slug}`, {
    build: { command: "pnpm run build" },
    assets: {
      directory: "dist",
      not_found_handling: "404-page"
    },
    adopt: true,
    domains: [{ domainName: domain, ...(zoneId ? { zoneId } : {}), adopt: true }]
  })

  console.log(`${slug} docs deployed -> https://${domain} (${site.url ?? "no workers.dev url"})`)

  await app.finalize()
  return site
}
