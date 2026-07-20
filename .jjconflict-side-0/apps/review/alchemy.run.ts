/**
 * Alchemy infrastructure-as-code for the smithers review service.
 *
 * One Cloudflare Worker (entry: src/server/worker.ts), one R2 bucket for
 * walkthroughs, one D1 database for sessions / api keys / usage / quota.
 * The Worker keeps its workers.dev URL and serves review.jjhub.tech as a
 * custom domain (the jjhub.tech zone is on this Cloudflare account).
 *
 * review.smithers.sh: the smithers.sh zone lives on Vercel DNS (registrar
 * Name.com), so serving it from this Worker needs Cloudflare for SaaS
 * (custom hostname on jjhub.tech + a CNAME at Vercel). The current
 * CLOUDFLARE_API_TOKEN lacks the SSL-and-Certificates permission for custom
 * hostnames and the available VERCEL_API_TOKEN is expired, so that leg is
 * gated behind REVIEW_ENABLE_SMITHERS_SH_ROUTE=1 until credentials exist.
 * See .smithers/specs/smithers-review-cloud.md.
 *
 * Deploy:   REVIEW_PUBLISH_TOKEN=... REVIEW_ADMIN_TOKEN=... REVIEW_METRICS_TOKEN=... \
 *           REVIEW_ANTHROPIC_API_KEY=... bun x alchemy deploy
 * Destroy:  bun x alchemy destroy
 *
 * Required env: CLOUDFLARE_API_TOKEN, ALCHEMY_PASSWORD, REVIEW_PUBLISH_TOKEN,
 *               REVIEW_ADMIN_TOKEN, REVIEW_METRICS_TOKEN, REVIEW_ANTHROPIC_API_KEY.
 */
import alchemy from "alchemy";
import { D1Database, R2Bucket, Worker } from "alchemy/cloudflare";

const JJHUB_ZONE_ID = "72854846f57d9e46794e7e6aae7e3328";

const app = await alchemy("smithers-review");

function requireSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to deploy`);
  return value;
}

const publishToken = requireSecret("REVIEW_PUBLISH_TOKEN");
const adminToken = requireSecret("REVIEW_ADMIN_TOKEN");
const metricsToken = requireSecret("REVIEW_METRICS_TOKEN");
const anthropicKey = requireSecret("REVIEW_ANTHROPIC_API_KEY");

const bucket = await R2Bucket("walkthroughs", {
  adopt: true,
});

const db = await D1Database("review-db", {
  adopt: true,
});

const smithersShRoutes =
  process.env.REVIEW_ENABLE_SMITHERS_SH_ROUTE === "1"
    ? [{ pattern: "review.smithers.sh/*", zoneId: JJHUB_ZONE_ID, adopt: true }]
    : [];

export const worker = await Worker("smithers-review", {
  entrypoint: "src/server/worker.ts",
  compatibilityDate: "2025-05-01",
  url: true,
  adopt: true,
  bindings: {
    WALKTHROUGHS: bucket,
    DB: db,
    REVIEW_PUBLISH_TOKEN: alchemy.secret(publishToken),
    ADMIN_TOKEN: alchemy.secret(adminToken),
    METRICS_TOKEN: alchemy.secret(metricsToken),
    ANTHROPIC_API_KEY: alchemy.secret(anthropicKey),
    PUBLIC_BASE_URL: process.env.REVIEW_PUBLIC_BASE_URL?.trim() || "https://review.jjhub.tech",
  },
  domains: [{ domainName: "review.jjhub.tech", zoneId: JJHUB_ZONE_ID, adopt: true }],
  routes: smithersShRoutes,
});

console.log(`smithers review deployed → ${worker.url ?? "(no workers.dev url)"}`);

await app.finalize();
