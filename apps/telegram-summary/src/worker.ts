import type { ExecutionContextLike, ScheduledControllerLike, TelegramSummaryEnv } from "./env.ts";
import { ingestTelegramUpdates, latestDigest, listDigests, runDailyDigest, status } from "./service.ts";
import { digestPayload, json, notFound, renderDashboard } from "./ui.ts";

function isAuthorized(request: Request, env: TelegramSummaryEnv): boolean {
  const expected = env.ADMIN_TOKEN?.trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${expected}`;
}

function requireAdmin(request: Request, env: TelegramSummaryEnv): Response | null {
  if (isAuthorized(request, env)) return null;
  return json({ error: env.ADMIN_TOKEN ? "Unauthorized" : "ADMIN_TOKEN is not configured." }, { status: 401 });
}

async function handleApi(request: Request, env: TelegramSummaryEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/status" && request.method === "GET") return json(await status(env));
  if (url.pathname === "/api/latest" && request.method === "GET") {
    return json({ digest: digestPayload(await latestDigest(env.DB)) });
  }
  if (url.pathname === "/api/digests" && request.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const rows = await listDigests(env.DB, Number.isFinite(limit) ? limit : 20);
    return json({ digests: rows.map(digestPayload) });
  }
  if (url.pathname === "/api/ingest" && request.method === "POST") {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    return json(await ingestTelegramUpdates(env));
  }
  if (url.pathname === "/api/run-digest" && request.method === "POST") {
    const unauthorized = requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    await ingestTelegramUpdates(env);
    return json(await runDailyDigest(env));
  }
  return notFound();
}

async function fetchHandler(request: Request, env: TelegramSummaryEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") return renderDashboard();
  if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
  if (url.pathname.startsWith("/api/")) return await handleApi(request, env);
  return notFound();
}

async function scheduledHandler(controller: ScheduledControllerLike, env: TelegramSummaryEnv): Promise<void> {
  if (controller.cron === env.DIGEST_CRON) {
    await ingestTelegramUpdates(env);
    await runDailyDigest(env, controller.scheduledTime ?? Date.now());
    return;
  }
  await ingestTelegramUpdates(env, controller.scheduledTime ?? Date.now());
}

export default {
  fetch(request: Request, env: TelegramSummaryEnv): Promise<Response> {
    return fetchHandler(request, env);
  },
  scheduled(controller: ScheduledControllerLike, env: TelegramSummaryEnv, ctx: ExecutionContextLike): void {
    ctx.waitUntil(scheduledHandler(controller, env));
  },
};
