/**
 * Cloudflare deployment for signal.smithers.sh — The Smithers Signal magazine.
 *
 * Worker + static Assets (the Vite-built React SPA), following the
 * apps/kimi-benchmarks-site pattern. Adopts the SIGNAL_REPORTS KV namespace
 * created by ../scheduler/alchemy.run.ts (same logical CF-side resource name;
 * `adopt: true` on both sides means whichever stack deploys first creates it
 * and the other one adopts it — see alchemy.run.ts docs on adopt semantics).
 *
 * Deploy:
 *   pnpm -C apps/signal run site:build
 *   CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... pnpm -C apps/signal exec alchemy deploy site/alchemy.run.ts
 *
 * Optional env:
 *   SIGNAL_SITE_DOMAIN=preview-signal.smithers.sh
 *   CLOUDFLARE_SMITHERS_ZONE_ID=...
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import { Assets, KVNamespace, Worker } from "alchemy/cloudflare";

const DEFAULT_DOMAIN = "signal.smithers.sh";
const SMITHERS_SH_ZONE_ID = "8ebd98d2f0dc7d8db2e61f31ebc19c14";
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || "dd3525a4132493566aeb38de533c8827";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "dist");
const domain = process.env.SIGNAL_SITE_DOMAIN?.trim() || DEFAULT_DOMAIN;
const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || SMITHERS_SH_ZONE_ID;

const app = await alchemy("signal-site");

const kv = await KVNamespace("signal-reports", {
  title: "SIGNAL_REPORTS",
  adopt: true,
  accountId: CLOUDFLARE_ACCOUNT_ID,
});

export const worker = await Worker("signal-site", {
  entrypoint: "src/worker.ts",
  // cwd anchors the (relative) entrypoint to this file's directory instead of
  // process.cwd(), so deploy works regardless of the invoking shell's cwd.
  cwd: here,
  compatibilityDate: "2026-07-16",
  url: true,
  adopt: true,
  accountId: CLOUDFLARE_ACCOUNT_ID,
  bindings: {
    ASSETS: await Assets({
      path: siteDir,
    }),
    SIGNAL_REPORTS: kv,
  },
  assets: {
    not_found_handling: "single-page-application",
  },
  domains: [{ domainName: domain, zoneId, adopt: true }],
});

console.log(`The Smithers Signal deployed -> https://${domain} (${worker.url ?? "no workers.dev url"})`);

await app.finalize();
