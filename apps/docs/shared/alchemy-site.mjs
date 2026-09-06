// @ts-check
/** Alchemy 2 stack factory shared by every package documentation site. */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"

/**
 * Declare a static site without running its stack or contacting Cloudflare.
 *
 * Physical names from Alchemy 1 cannot be derived from Alchemy 2's naming
 * scheme. Requiring the existing Worker name preserves deployed resources.
 * For a new site, choose a unique name explicitly. Alchemy refuses a custom
 * hostname belonging to another Worker; hostname transfers are not automatic.
 *
 * @param {{ readonly slug: string }} options
 */
export function makeDocsSiteStack({ slug }) {
  const prefix = slug.toUpperCase().replace(/-/g, "_")
  const domain = process.env[`${prefix}_SITE_DOMAIN`]?.trim() || `${slug}.smithers.sh`
  const name = process.env[`${prefix}_WORKER_NAME`]?.trim()
  if (!name) {
    throw new Error(`Set ${prefix}_WORKER_NAME to the existing Worker name (or a unique name for a new site); see apps/docs/README.md`)
  }
  const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined

  return Alchemy.Stack(
    `smithers-docs-${slug}`,
    { providers: Cloudflare.providers(), state: Alchemy.localState() },
    Cloudflare.Website.StaticSite(`smithers-docs-${slug}`, {
      name,
      command: "pnpm run build",
      outdir: "dist",
      assets: { notFoundHandling: "404-page" },
      workersDev: false,
      domain: { name: domain, ...(zoneId ? { zoneId } : {}) }
    })
  )
}
