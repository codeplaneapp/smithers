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
 * Slugs whose docs site is allowed to take a hostname an existing Worker
 * already serves.
 *
 * Deliberately a short, explicit list rather than a default. flows.smithers.sh
 * previously served a Worker named `flows-docs`; the package docs own that
 * hostname now, so the binding is overridden on deploy. Nothing else belongs
 * here without the same decision being made out loud.
 */
const claimsExistingHostname = new Set(["flows"])

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
    // No workers.dev URL. Every one of these sites is reached at
    // <slug>.smithers.sh, so the per-worker subdomain serves nothing, and
    // asking for it is what made the generated script name a problem:
    // Cloudflare measures that name only when it has to become a hostname
    // label. The name is <app>-<resource>-<owner>, which here is 41 + 2x the
    // slug length, and it hit two separate ceilings. Over 54 characters it is
    // refused while preview URLs are on ("Script name is too long to be used
    // with previews enabled"), which failed every slug longer than six:
    // errors and memory deployed, harness and integrations did not. Turning
    // previews off raised the ceiling to 63 and platform-browser still failed
    // at 73 ("The Worker name is too long to be used as a subdomain").
    // Declining the subdomain removes the constraint rather than negotiating
    // with it, and leaves the resource names stable, which matters because
    // renaming them would orphan the workers already deployed.
    url: false,
    domains: [{
      domainName: domain,
      ...(zoneId ? { zoneId } : {}),
      adopt: true,
      // Taking a hostname that another Worker already serves is opt-in, one
      // slug at a time. Cloudflare refuses the binding with a 409 by default,
      // and that refusal is worth keeping: ui.smithers.sh serves the Smithers
      // UI application and sync.smithers.sh serves the cloud sync worker, so a
      // blanket override here would have replaced a product with a docs site.
      ...(claimsExistingHostname.has(slug) ? { overrideExistingOrigin: true } : {})
    }]
  })

  console.log(`${slug} docs deployed -> https://${domain} (${site.url ?? "no workers.dev url"})`)

  await app.finalize()
  return site
}
