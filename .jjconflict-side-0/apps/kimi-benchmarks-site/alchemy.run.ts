/**
 * Cloudflare deployment for kimibenchmarks.smithers.sh.
 *
 * Static benchmark report and sanitized evidence bundle under ./site.
 *
 * Deploy:
 *   CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... pnpm -C apps/kimi-benchmarks-site deploy
 *
 * Optional env:
 *   KIMI_BENCHMARKS_SITE_DOMAIN=preview-kimibenchmarks.smithers.sh
 *   CLOUDFLARE_SMITHERS_ZONE_ID=...
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import { Assets, Worker } from "alchemy/cloudflare";

const DEFAULT_DOMAIN = "kimibenchmarks.smithers.sh";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "site");
const domain =
  process.env.KIMI_BENCHMARKS_SITE_DOMAIN?.trim() || DEFAULT_DOMAIN;
const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined;

const app = await alchemy("kimi-benchmarks-site");

export const worker = await Worker("kimi-benchmarks-site", {
  entrypoint: "src/worker.ts",
  compatibilityDate: "2026-07-16",
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

console.log(
  `Kimi benchmarks site deployed -> https://${domain} (${worker.url ?? "no workers.dev url"})`,
);

await app.finalize();
