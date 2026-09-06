/**
 * Alchemy 2 stack for the static smithers.sh site.
 *
 * The dedicated physical Worker smithers-site-v1 matches wrangler.jsonc.
 * The existing smithers-site Worker serves another site and is not adopted here.
 * The CLI evaluates this default-exported stack; importing it deploys nothing.
 * See apps/docs/README.md for state migration and package-site deployment.
 */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"

const domain = process.env.SMITHERS_SITE_DOMAIN?.trim() || "smithers.sh"
const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined
const workerName = process.env.SMITHERS_SITE_WORKER_NAME?.trim()
if (domain !== "smithers.sh" && !workerName) {
  throw new Error("Set SMITHERS_SITE_WORKER_NAME to a separate Worker name for a preview domain")
}

export const siteProps = {
  name: workerName || "smithers-site-v1",
  command: "pnpm run build",
  outdir: "dist",
  compatibility: { date: "2026-07-02" },
  assets: { notFoundHandling: "404-page" },
  workersDev: false,
  domain: { name: domain, ...(zoneId ? { zoneId } : {}) }
} satisfies Cloudflare.Website.StaticSiteProps

export default Alchemy.Stack(
  "smithers-site",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Cloudflare.Website.StaticSite("smithers-site", siteProps)
)
