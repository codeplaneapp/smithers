/**
 * Cloudflare deployment for openclaw.smithers.sh.
 *
 * The marketing site source lives with the native OpenClaw plugin at
 * apps/cli/src/openclaw-plugin/site so the packaged plugin and the deployed
 * public site stay in sync.
 *
 * Deploy:
 *   CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... pnpm -C apps/openclaw-site deploy
 *
 * Optional env:
 *   OPENCLAW_SITE_DOMAIN=preview-openclaw.smithers.sh
 *   CLOUDFLARE_SMITHERS_ZONE_ID=...
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import { Assets, Worker } from "alchemy/cloudflare";

const DEFAULT_DOMAIN = "openclaw.smithers.sh";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..", "cli", "src", "openclaw-plugin", "site");
const domain = process.env.OPENCLAW_SITE_DOMAIN?.trim() || DEFAULT_DOMAIN;
const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined;

const app = await alchemy("openclaw-site");

export const worker = await Worker("openclaw-site", {
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

console.log(`openclaw site deployed -> https://${domain} (${worker.url ?? "no workers.dev url"})`);

await app.finalize();
