import { getContainer } from "@cloudflare/containers";
import type { Env } from "./env";
import { etClock } from "./etTime";
import { isPrimaryFireHour, isWatchdogFireTime, timingSafeEqual } from "./guards";
export { Runner } from "./runner";

const PRIMARY_CRONS = new Set(["0 11 * * *", "0 12 * * *"]);
const WATCHDOG_CRON = "15 12,13 * * *";
// Best-effort in-flight marker (KV has no atomic compare-and-swap) so the 8:15am
// watchdog doesn't fire a second concurrent full run while the primary run is
// still mid-flight — duplicate publishes are prevented downstream by the
// verifier's idempotent-delivery check, but overlapping runs still burn API spend.
// 90 min, not 20: a full pipeline run on the container instance class takes
// 40-60+ min (observed live 2026-07-17), and a marker that expires mid-run lets
// the watchdog/manual triggers start an overlapping run. The marker is deleted
// promptly on completion, so the long TTL only delays re-triggering after a
// crashed run.
const INFLIGHT_TTL_SECONDS = 90 * 60;
const WATCHDOG_MARKER_TTL_SECONDS = 48 * 60 * 60;

type TriggerResult = { ok: boolean; status: number; body: unknown };

async function isRunInFlight(env: Env, dateEt: string): Promise<boolean> {
  return (await env.SIGNAL_REPORTS.get(`inflight:${dateEt}`)) !== null;
}

async function triggerRunner(env: Env, dateEt: string): Promise<TriggerResult> {
  await env.SIGNAL_REPORTS.put(`inflight:${dateEt}`, "1", { expirationTtl: INFLIGHT_TTL_SECONDS });
  try {
    const container = getContainer(env.RUNNER);
    const response = await container.fetch(new Request("http://runner/run", { method: "POST" }));
    const body = await response.json().catch(() => ({ ok: response.ok }));
    return { ok: response.ok, status: response.status, body };
  } finally {
    await env.SIGNAL_REPORTS.delete(`inflight:${dateEt}`);
  }
}

async function alert(env: Env, message: string): Promise<void> {
  console.error(`[signal-scheduler] ${message}`);
  if (!env.SIGNAL_ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.SIGNAL_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `[The Smithers Signal] ${message}` }),
    });
  } catch (error) {
    console.error(`[signal-scheduler] alert webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return false;
  return timingSafeEqual(token, env.MANUAL_TRIGGER_SECRET);
}

async function handlePrimaryCron(env: Env, ctx: ExecutionContext, at: Date): Promise<void> {
  const { hour, dateEt } = etClock(at);
  if (!isPrimaryFireHour(hour)) return; // the other of the two 11:00/12:00 UTC triggers is the DST no-op
  console.log(`[signal-scheduler] 7am ET primary trigger firing for ${dateEt}`);
  ctx.waitUntil(
    triggerRunner(env, dateEt).then(async (result) => {
      if (!result.ok) await alert(env, `Primary 7am ET run for ${dateEt} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
    }),
  );
}

async function handleWatchdogCron(env: Env, ctx: ExecutionContext, at: Date): Promise<void> {
  const { hour, minute, dateEt } = etClock(at);
  if (!isWatchdogFireTime(hour, minute)) return; // the other UTC watchdog firing is the DST no-op
  ctx.waitUntil(
    (async () => {
      const report = await env.SIGNAL_REPORTS.get(`report:${dateEt}`);
      if (report !== null) return; // published on time, nothing to do

      if (await isRunInFlight(env, dateEt)) {
        console.log(`[signal-scheduler] watchdog: a run for ${dateEt} is already in flight; skipping re-trigger`);
        return;
      }

      const watchdogKey = `watchdog:${dateEt}`;
      const alreadyRetried = (await env.SIGNAL_REPORTS.get(watchdogKey)) !== null;
      if (alreadyRetried) {
        await alert(env, `8:15am ET watchdog: report:${dateEt} is STILL missing after the one automatic retry. Needs a human.`);
        return;
      }

      await env.SIGNAL_REPORTS.put(watchdogKey, JSON.stringify({ retriedAt: new Date().toISOString() }), { expirationTtl: WATCHDOG_MARKER_TTL_SECONDS });
      await alert(env, `8:15am ET watchdog: report:${dateEt} is missing. Re-triggering the runner once.`);
      const result = await triggerRunner(env, dateEt);
      if (!result.ok) await alert(env, `Watchdog re-trigger for ${dateEt} also failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
    })(),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "signal-scheduler" });
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      if (!(await isAuthorized(request, env))) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const { dateEt } = etClock(new Date());
      if (await isRunInFlight(env, dateEt)) {
        return Response.json({ ok: false, error: "already in flight", dateEt }, { status: 409 });
      }
      // Run under waitUntil (matching the cron handlers below) so the container
      // run survives the triggering client disconnecting/timing out — a run can
      // take much longer than an HTTP client is willing to stay connected for,
      // and a canceled fetch here would otherwise kill the run mid-flight and
      // leave a stale inflight marker for up to INFLIGHT_TTL_SECONDS.
      ctx.waitUntil(
        triggerRunner(env, dateEt).then(async (result) => {
          if (!result.ok) await alert(env, `Manual trigger run for ${dateEt} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
        }),
      );
      return Response.json({ ok: true, status: "started", dateEt }, { status: 202 });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const at = new Date(event.scheduledTime);
    if (event.cron === WATCHDOG_CRON) {
      await handleWatchdogCron(env, ctx, at);
      return;
    }
    if (PRIMARY_CRONS.has(event.cron)) {
      await handlePrimaryCron(env, ctx, at);
      return;
    }
    console.warn(`[signal-scheduler] scheduled() fired for unrecognized cron pattern: ${event.cron}`);
  },
};
