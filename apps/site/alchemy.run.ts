/**
 * Alchemy 2 stack for the static smithers.sh site.
 *
 * The physical Worker name matches wrangler.jsonc. For an existing Worker,
 * review `pnpm exec alchemy deploy --dry-run --adopt` before the first deployment.
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

export default Alchemy.Stack(
  "smithers-site",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Cloudflare.Website.StaticSite("smithers-site", {
    name: workerName || "smithers-site",
    command: "pnpm run build",
    outdir: "dist",
    compatibility: { date: "2026-07-02" },
    assets: { notFoundHandling: "404-page" },
    workersDev: false,
    domain: { name: domain, ...(zoneId ? { zoneId } : {}) }
  })
)
