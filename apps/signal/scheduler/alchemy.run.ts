/**
 * Alchemy infrastructure-as-code for The Smithers Signal's scheduler stack:
 * the daily-ceo-intel runner Container (built from ../runner/Dockerfile),
 * the Worker that cron-triggers it at 7am ET (DST-correct) with an 8:15am ET
 * watchdog, and an authenticated manual-trigger endpoint.
 *
 * Also owns creation/adoption of the shared storage the site stack adopts:
 * KV namespace SIGNAL_REPORTS and R2 bucket signal-state (see spec
 * .smithers/specs/daily-ceo-intel.md "## Cloudflare architecture (phase 2)").
 *
 * Deploy:  CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... ANTHROPIC_API_KEY=... \
 *          OPENAI_API_KEY=... GEMINI_API_KEY=... SIGNAL_MANUAL_TRIGGER_SECRET=... \
 *          bun x alchemy deploy scheduler/alchemy.run.ts
 * Destroy: bun x alchemy destroy scheduler/alchemy.run.ts
 *
 * Model credentials: at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * GEMINI_API_KEY must be set — whichever are present get passed through as
 * container secrets, and the runner's SIGNAL_MODEL_PROVIDER=auto (default)
 * probes them in that order at run start (see
 * .smithers/lib/daily-ceo-intel/modelProvider.ts). Anthropic is spec-preferred:
 * with all three set, a billing/auth failure on Anthropic alone still falls
 * through to OpenAI/Gemini without a redeploy.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import alchemy from "alchemy";
import { Container, KVNamespace, R2Bucket, Worker } from "alchemy/cloudflare";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || "dd3525a4132493566aeb38de533c8827";

const app = await alchemy("signal-scheduler");

const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
if (!anthropicApiKey && !openaiApiKey && !geminiApiKey) {
  throw new Error(
    "At least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY is required to deploy — the runner's provider fallback (SIGNAL_MODEL_PROVIDER=auto by default) needs at least one usable model credential to classify/compose an issue.",
  );
}

const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!cloudflareApiToken) throw new Error("CLOUDFLARE_API_TOKEN is required to deploy");

const manualTriggerSecret = process.env.SIGNAL_MANUAL_TRIGGER_SECRET?.trim();
if (!manualTriggerSecret) {
  throw new Error(
    "SIGNAL_MANUAL_TRIGGER_SECRET is required to deploy (never auto-generated, to avoid leaking a secret into deploy logs). Generate one yourself, e.g.:\n  export SIGNAL_MANUAL_TRIGGER_SECRET=$(uuidgen)\nand store it in your secret manager — it will not be printed by this script.",
  );
}

const kv = await KVNamespace("signal-reports", {
  title: "SIGNAL_REPORTS",
  adopt: true,
  accountId: CLOUDFLARE_ACCOUNT_ID,
});

const bucket = await R2Bucket("signal-state", {
  name: "signal-state",
  adopt: true,
  accountId: CLOUDFLARE_ACCOUNT_ID,
});

const runner = await Container("signal-runner", {
  className: "Runner",
  // context must be the repo root (absolute — alchemy resolves relative
  // contexts against process.cwd(), which is wrong when this script is
  // invoked via `pnpm -C apps/signal run deploy:scheduler`): the Dockerfile
  // COPYs repo-root paths (package.json, apps/, packages/, .smithers/, config/).
  build: { context: REPO_ROOT, dockerfile: join("apps", "signal", "runner", "Dockerfile") },
  maxInstances: 2,
  // standard (1/2 vCPU, 4 GiB), not basic (1/4 vCPU, 1 GiB): the headless
  // smithers pipeline ground for 40-60+ min per run on basic (observed live
  // 2026-07-17), which starved the inflight-marker window and made prod
  // verification miserable.
  instanceType: "standard",
  adopt: true,
  accountId: CLOUDFLARE_ACCOUNT_ID,
});

export const worker = await Worker("signal-scheduler", {
  entrypoint: "src/worker.ts",
  // cwd anchors the (relative) entrypoint to this file's directory instead of
  // process.cwd(), so deploy works regardless of the invoking shell's cwd.
  cwd: HERE,
  compatibilityDate: "2026-07-16",
  compatibilityFlags: ["nodejs_compat"],
  url: true,
  adopt: true,
  accountId: CLOUDFLARE_ACCOUNT_ID,
  bindings: {
    RUNNER: runner,
    SIGNAL_REPORTS: kv,
    ...(anthropicApiKey ? { ANTHROPIC_API_KEY: alchemy.secret(anthropicApiKey) } : {}),
    ...(openaiApiKey ? { OPENAI_API_KEY: alchemy.secret(openaiApiKey) } : {}),
    ...(geminiApiKey ? { GEMINI_API_KEY: alchemy.secret(geminiApiKey) } : {}),
    CLOUDFLARE_ACCOUNT_ID: CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: alchemy.secret(cloudflareApiToken),
    CLOUDFLARE_KV_NAMESPACE_ID: kv.namespaceId,
    CLOUDFLARE_R2_BUCKET: bucket.name,
    MANUAL_TRIGGER_SECRET: alchemy.secret(manualTriggerSecret),
    ...(process.env.SIGNAL_ALERT_WEBHOOK_URL ? { SIGNAL_ALERT_WEBHOOK_URL: process.env.SIGNAL_ALERT_WEBHOOK_URL } : {}),
  },
  // Primary: fires twice daily (11:00 & 12:00 UTC); the in-handler ET-hour==7 guard
  // (DST-correct) makes exactly one of the two a no-op on any given day.
  // Watchdog: fires twice daily (12:15 & 13:15 UTC); the in-handler ET 8:15 guard
  // checks KV report:{today-ET} and alerts + re-triggers once if it's missing.
  crons: ["0 11 * * *", "0 12 * * *", "15 12,13 * * *"],
});

console.log(`signal-scheduler deployed -> ${worker.url ?? "(no workers.dev url)"}`);
console.log(`manual trigger: POST ${worker.url}/trigger  (Authorization: Bearer <SIGNAL_MANUAL_TRIGGER_SECRET>)`);
console.log(`KV namespace SIGNAL_REPORTS id=${kv.namespaceId}; R2 bucket=${bucket.name}`);

await app.finalize();
