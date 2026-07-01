/**
 * Cloudflare deployment for telegram-summary.smithers.sh.
 *
 * The Worker is the production bot service: Cloudflare cron ingests Telegram
 * updates into D1, runs a Kimi daily digest, posts back to Telegram, and serves
 * a small dashboard. Smithers remains the local workflow/replay surface.
 *
 * Deploy:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_SUMMARY_SOURCE_CHAT_ID=... \
 *   TELEGRAM_SUMMARY_ADMIN_TOKEN=... MOONSHOT_API_KEY=... \
 *   CLOUDFLARE_SMITHERS_ZONE_ID=... bun x alchemy deploy
 *
 * MOONSHOT_API_KEY can be omitted for an infrastructure-only deploy; digest
 * runs will report missing Kimi credentials until the secret is provided.
 */
import alchemy from "alchemy";
import { D1Database, Worker } from "alchemy/cloudflare";

const DOMAIN = "telegram-summary.smithers.sh";
const app = await alchemy("telegram-summary");

function optionalSecret(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function optionalText(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const db = await D1Database("telegram-summary-db", {
  adopt: true,
});

const secrets = {
  TELEGRAM_BOT_TOKEN: optionalSecret("TELEGRAM_BOT_TOKEN"),
  MOONSHOT_API_KEY: optionalSecret("MOONSHOT_API_KEY"),
  ADMIN_TOKEN: optionalSecret("TELEGRAM_SUMMARY_ADMIN_TOKEN"),
};

const zoneId = optionalText("CLOUDFLARE_SMITHERS_ZONE_ID");
const ingestCron = optionalText("TELEGRAM_SUMMARY_INGEST_CRON") ?? "*/15 * * * *";
const digestCron = optionalText("TELEGRAM_SUMMARY_DIGEST_CRON") ?? "0 0 * * *";

export const worker = await Worker("telegram-summary", {
  entrypoint: "src/worker.ts",
  compatibilityDate: "2026-06-20",
  url: true,
  adopt: true,
  bindings: {
    DB: db,
    PUBLIC_BASE_URL: optionalText("TELEGRAM_SUMMARY_PUBLIC_BASE_URL") ?? `https://${DOMAIN}`,
    TELEGRAM_SOURCE_CHAT_ID: optionalText("TELEGRAM_SUMMARY_SOURCE_CHAT_ID") ?? "",
    TELEGRAM_OUTPUT_CHAT_ID: optionalText("TELEGRAM_SUMMARY_OUTPUT_CHAT_ID") ?? "",
    TELEGRAM_OUTPUT_THREAD_ID: optionalText("TELEGRAM_SUMMARY_OUTPUT_THREAD_ID") ?? "",
    KIMI_MODEL: optionalText("KIMI_MODEL") ?? "kimi-k2.6",
    DIGEST_WINDOW_HOURS: optionalText("TELEGRAM_SUMMARY_WINDOW_HOURS") ?? "24",
    DIGEST_TOPIC_HINT: optionalText("TELEGRAM_SUMMARY_TOPIC_HINT") ?? "",
    INGEST_CRON: ingestCron,
    DIGEST_CRON: digestCron,
    ...(secrets.TELEGRAM_BOT_TOKEN ? { TELEGRAM_BOT_TOKEN: alchemy.secret(secrets.TELEGRAM_BOT_TOKEN) } : {}),
    ...(secrets.MOONSHOT_API_KEY ? { MOONSHOT_API_KEY: alchemy.secret(secrets.MOONSHOT_API_KEY) } : {}),
    ...(secrets.ADMIN_TOKEN ? { ADMIN_TOKEN: alchemy.secret(secrets.ADMIN_TOKEN) } : {}),
  },
  crons: [ingestCron, digestCron],
  domains: [{ domainName: DOMAIN, ...(zoneId ? { zoneId } : {}), adopt: true }],
});

console.log(`telegram summary deployed -> ${worker.url ?? "(no workers.dev url)"}`);

await app.finalize();
