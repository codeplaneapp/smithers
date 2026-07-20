/**
 * Cloudflare deployment for telegram.smithers.sh.
 *
 * Marketing site for Smithers on Telegram. Static content is self-contained under ./site.
 *
 * Deploy:
 *   CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... pnpm -C apps/telegram-site deploy
 *
 * Optional env:
 *   TELEGRAM_SITE_DOMAIN=preview-telegram.smithers.sh
 *   CLOUDFLARE_SMITHERS_ZONE_ID=...
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import { Assets, Worker } from "alchemy/cloudflare";

const DEFAULT_DOMAIN = "telegram.smithers.sh";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "site");
const domain = process.env.TELEGRAM_SITE_DOMAIN?.trim() || DEFAULT_DOMAIN;
const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined;

const app = await alchemy("telegram-site");

export const worker = await Worker("telegram-site", {
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

console.log(`telegram site deployed -> https://${domain} (${worker.url ?? "no workers.dev url"})`);

await app.finalize();
