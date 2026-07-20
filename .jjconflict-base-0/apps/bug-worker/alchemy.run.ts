/**
 * Alchemy infrastructure-as-code for bug.smithers.sh.
 *
 * One Cloudflare Worker (entry: src/worker.ts) plus one KV namespace for bug
 * reports and the per-IP rate-limit counters. The smithers.sh zone lives on
 * this Cloudflare account (migrated from Vercel DNS 2026-06-25), so the
 * Worker serves bug.smithers.sh as a custom domain directly.
 *
 * Deploy:   BUG_ADMIN_TOKEN=... bun x alchemy deploy
 *           (equivalently: BUG_ADMIN_TOKEN=... pnpm -C apps/bug-worker deploy)
 * Destroy:  bun x alchemy destroy
 *
 * Required env: CLOUDFLARE_API_TOKEN, ALCHEMY_PASSWORD, BUG_ADMIN_TOKEN.
 * Optional env: CLOUDFLARE_SMITHERS_ZONE_ID (alchemy resolves the zone from
 * the domain when omitted, same convention as apps/telegram-summary).
 */
import alchemy from "alchemy";
import { KVNamespace, Worker } from "alchemy/cloudflare";

const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined;

const app = await alchemy("smithers-bug-worker");

const adminToken = process.env.BUG_ADMIN_TOKEN?.trim();
if (!adminToken) throw new Error("BUG_ADMIN_TOKEN is required to deploy");

const bugs = await KVNamespace("bug-reports", {
  adopt: true,
});

export const worker = await Worker("smithers-bug-worker", {
  entrypoint: "src/worker.ts",
  compatibilityDate: "2025-05-01",
  url: true,
  adopt: true,
  bindings: {
    BUGS: bugs,
    BUG_ADMIN_TOKEN: alchemy.secret(adminToken),
    PUBLIC_BASE_URL: process.env.BUG_PUBLIC_BASE_URL?.trim() || "https://bug.smithers.sh",
  },
  domains: [{ domainName: "bug.smithers.sh", ...(zoneId ? { zoneId } : {}), adopt: true }],
});

console.log(`smithers bug worker deployed → ${worker.url ?? "(no workers.dev url)"}`);

await app.finalize();
