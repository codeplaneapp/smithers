/**
 * Cloudflare deployment for plugins.smithers.sh.
 *
 * The marketing site for the Smithers plugins that run inside Claude Code and
 * Codex. The static content is self-contained under ./site (there is no single
 * plugin to keep it in sync with; the page covers both plugins).
 *
 * Deploy:
 *   CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... pnpm -C apps/plugins-site deploy
 *
 * Optional env:
 *   PLUGINS_SITE_DOMAIN=preview-plugins.smithers.sh
 *   CLOUDFLARE_SMITHERS_ZONE_ID=...
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import { Assets, Worker } from "alchemy/cloudflare";

const DEFAULT_DOMAIN = "plugins.smithers.sh";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "site");
const domain = process.env.PLUGINS_SITE_DOMAIN?.trim() || DEFAULT_DOMAIN;
const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined;

const app = await alchemy("plugins-site");

export const worker = await Worker("plugins-site", {
  entrypoint: "src/worker.ts",
  compatibilityDate: "2026-07-02",
  url: true,
  adopt: true,
  bindings: {
    ASSETS: await Assets({
      path: relative(process.cwd(), siteDir),
    }),
  },
  assets: {
    not_found_handling: "single-page-application",
  },
  domains: [{ domainName: domain, ...(zoneId ? { zoneId } : {}), adopt: true }],
});

console.log(`plugins site deployed -> https://${domain} (${worker.url ?? "no workers.dev url"})`);

await app.finalize();
