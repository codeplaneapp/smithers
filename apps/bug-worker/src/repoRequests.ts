import type { BugWorkerEnv } from "./env.ts";
import { forkRepo } from "./repoForks.ts";
import { checkRateLimit, readBodyBounded, timingSafeStringEqual, type BugWorkerDeps } from "./worker.ts";

const prefix = "repo-request:";
const cors = {
  "access-control-allow-origin": "*",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const json = (status: number, body: unknown, headers = cors) => new Response(JSON.stringify(body), { status, headers });
type Repo = { name: string; url: string };
type Ready = { appUrl: string; completedAt: string };
type Leader = { name: string; count: number };
/** One key holds the ranked leaderboard, so listing costs one read plus one readiness read per entry. */
const leaderboardKey = "repo-nominations-top";
const listTop = 20;
/** Browsers reuse a list for this long; KV is eventually consistent over the same window. */
const listCache = { ...cors, "cache-control": "public, max-age=60" };

/** Accept repository roots only; never fetch a user-supplied host. */
export function repoName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 250) return null;
  const name = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/i, "");
  return /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(name) && !/[\/]\.{1,2}$/.test(name)
    ? name.toLowerCase() : null;
}

async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function read<T>(env: BugWorkerEnv, key: string): Promise<T | null> {
  const value = await env.BUGS.get(key);
  return value === null ? null : JSON.parse(value) as T;
}
/** Distinct nominations recorded for a repository; one accepted POST is one nomination. */
async function nominations(env: BugWorkerEnv, name: string) {
  return Number(await env.BUGS.get(`repo-nominations:${name}`)) || 0;
}
async function publicRepo(env: BugWorkerEnv, repo: Repo, count?: number) {
  const ready = await read<Ready>(env, `repo-ready:${repo.name}`);
  return {
    ...repo,
    status: ready ? "ready" : "smithering",
    appUrl: ready?.appUrl ?? null,
    nominations: count ?? await nominations(env, repo.name),
  };
}
/** Rewrite the leaderboard with one repository's new count; ties break on name. */
async function rank(env: BugWorkerEnv, name: string, count: number) {
  const leaders = (await read<Leader[]>(env, leaderboardKey) ?? []).filter((leader) => leader.name !== name);
  leaders.push({ name, count });
  leaders.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  await env.BUGS.put(leaderboardKey, JSON.stringify(leaders.slice(0, listTop)));
}
/** Repositories ranked by nominations, most nominated first, exact at any catalog size. */
async function mostNominated(env: BugWorkerEnv) {
  const leaders = await read<Leader[]>(env, leaderboardKey) ?? [];
  return Promise.all(leaders.map((leader) => publicRepo(env, { name: leader.name, url: `https://github.com/${leader.name}` }, leader.count)));
}
async function list(env: BugWorkerEnv, keyPrefix: string, cursor?: string, limit = 50) {
  if (!env.BUGS.list) throw new Error("KV listing unavailable");
  return env.BUGS.list({ prefix: keyPrefix, limit, ...(cursor ? { cursor } : {}) });
}

/** Bounded delivery, with per-recipient receipts and provider deduplication on retries. */
async function notify(env: BugWorkerEnv, deps: BugWorkerDeps, name: string, ready: Ready, cursor?: string) {
  if (!env.RESEND_API_KEY || !env.NOTIFICATION_FROM) return { pending: true, reason: "email_not_configured" };
  const page = await list(env, `repo-subscriber:${name}:`, cursor);
  let sent = 0;
  let failed = 0;
  for (const key of page.keys) {
    if (await env.BUGS.get(`repo-notified:${key.name}`)) continue;
    const email = await env.BUGS.get(key.name);
    if (!email) continue;
    try {
      const response = await deps.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json",
          "idempotency-key": `smithers-ready-${await hash(key.name)}`,
        },
        body: JSON.stringify({
          from: env.NOTIFICATION_FROM, to: [email], subject: `${name} is ready in Smithers`,
          text: `You asked to be notified when ${name} was smithered. It is now supported in Smithers and available to everyone.\n\nOpen in Smithers: ${ready.appUrl}\n\nThis is the one-time notification you requested at smithers.sh.`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) { failed++; continue; }
      await env.BUGS.put(`repo-notified:${key.name}`, ready.completedAt);
      sent++;
    } catch { failed++; }
  }
  return { sent, failed, pending: failed > 0 || !page.list_complete, cursor: page.list_complete ? null : page.cursor };
}

export async function handleRepoRequests(request: Request, env: BugWorkerEnv, deps: BugWorkerDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = url.pathname.slice("/api/repo-requests".length);
    if (request.method === "GET" && route === "") {
      const query = url.searchParams.get("repo");
      if (query === null) return json(200, { repos: await mostNominated(env) }, listCache);
      const name = repoName(query);
      if (!name) return json(400, { error: "Enter a GitHub repository URL or owner/repo." });
      const repo = await read<Repo>(env, `${prefix}${name}`);
      if (!repo) return json(404, { error: "Repository has not been requested." });
      return json(200, { repo: await publicRepo(env, repo) });
    }
    const admin = route === "/complete" || route === "/notify";
    if (request.method !== "POST" || (route !== "" && !admin)) return json(404, { error: "Not found." });
    if (admin && (!env.BUG_ADMIN_TOKEN || !(await timingSafeStringEqual(request.headers.get("x-bug-admin") ?? "", env.BUG_ADMIN_TOKEN)))) {
      return json(401, { error: "Admin authentication required." });
    }
    if (!admin && !(await checkRateLimit(env, `repos:${request.headers.get("cf-connecting-ip") ?? "unknown"}`, deps.now()))) {
      return json(429, { error: "Too many requests. Please try again later." });
    }
    const raw = await readBodyBounded(request, 4096);
    if (raw === null) return json(413, { error: "Request is too large." });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch { return json(400, { error: "Send a JSON object." }); }
    const name = repoName(body.repo);
    if (!name) return json(400, { error: "Enter a GitHub repository URL or owner/repo." });
    let repo = await read<Repo>(env, `${prefix}${name}`);
    if (admin) {
      if (!repo) return json(404, { error: "Repository has not been requested." });
      let ready = await read<Ready>(env, `repo-ready:${name}`);
      if (route === "/complete") {
        let appUrl: URL;
        try { appUrl = new URL(String(body.appUrl)); } catch { return json(400, { error: "A public Smithers app URL is required." }); }
        if (appUrl.protocol !== "https:" || !["smithers.sh", "app.smithers.sh", "canary.smithers.sh"].includes(appUrl.hostname) || appUrl.username || appUrl.password || appUrl.port) {
          return json(400, { error: "Use an HTTPS URL on a Smithers app domain." });
        }
        if (ready && ready.appUrl !== appUrl.href) return json(409, { error: "This repository already has a published app URL." });
        if (!ready) {
          ready = { appUrl: appUrl.href, completedAt: new Date(deps.now()).toISOString() };
          await env.BUGS.put(`repo-ready:${name}`, JSON.stringify(ready));
        }
      }
      if (!ready) return json(409, { error: "Repository is still smithering." });
      // Publishing and delivery are separate: notification failure cannot undo readiness.
      return json(200, { repo: { ...repo, status: "ready", appUrl: ready.appUrl }, notifications: await notify(env, deps, name, ready, typeof body.cursor === "string" ? body.cursor : undefined) });
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if ((body.email !== undefined && typeof body.email !== "string") || (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
      return json(400, { error: "Enter a valid email address or leave it blank." });
    }
    if (!repo) {
      let response: Response;
      try {
        response = await deps.fetch(`https://api.github.com/repos/${name}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "Smithers-repo-requests" },
          signal: AbortSignal.timeout(10_000), redirect: "error",
        });
      } catch { return json(503, { error: "Could not check GitHub. Please try again." }); }
      if (response.status === 404) return json(400, { error: "That repository was not found. Please use a public GitHub repository." });
      if (!response.ok) return json(503, { error: "GitHub is unavailable or rate limited. Please try again later." });
      const github = await response.json() as { private?: boolean; disabled?: boolean; license?: { spdx_id?: string } };
      if (github.private !== false || github.disabled || !github.license?.spdx_id || github.license.spdx_id === "NOASSERTION") {
        return json(400, { error: "Please use a public repository with a recognized open-source license." });
      }
      // Immutable metadata and separate readiness keys prevent concurrent submissions
      // from resetting completed work. Each subscriber also has an independent key.
      repo = { name, url: `https://github.com/${name}` };
      await env.BUGS.put(`${prefix}${name}`, JSON.stringify(repo));
      await forkRepo(env, deps, name);
    }
    // A plain counter per repository: KV has no atomic increment, so two simultaneous
    // nominations can record one. That undercount is acceptable for a public tally,
    // and the leaderboard rewritten beside the counter shares the same trade-off.
    const count = await nominations(env, name) + 1;
    await env.BUGS.put(`repo-nominations:${name}`, String(count));
    await rank(env, name, count);
    const result = await publicRepo(env, repo, count);
    if (email && result.status !== "ready") await env.BUGS.put(`repo-subscriber:${name}:${await hash(email)}`, email);
    return json(200, { repo: result, subscribed: Boolean(email) && result.status !== "ready" });
  } catch {
    return json(503, { error: "Repository requests are temporarily unavailable. Please try again." });
  }
}

/** Re-scan completed repositories so late signups and failed sends are retried. */
export async function retryRepoNotifications(env: BugWorkerEnv, deps: BugWorkerDeps): Promise<void> {
  if (!env.RESEND_API_KEY || !env.NOTIFICATION_FROM) return;
  // A cursor bounds each invocation; repeated scheduled runs visit every repo.
  const cursor = await env.BUGS.get("repo-notification-sweep") || undefined;
  const page = await list(env, "repo-ready:", cursor, 2);
  for (const key of page.keys) {
    const ready = await read<Ready>(env, key.name);
    if (!ready) continue;
    const name = key.name.slice("repo-ready:".length);
    const cursorKey = `repo-notification-cursor:${name}`;
    const result = await notify(env, deps, name, ready, await env.BUGS.get(cursorKey) || undefined);
    if ("failed" in result && result.failed === 0) await env.BUGS.put(cursorKey, result.cursor || "");
  }
  await env.BUGS.put("repo-notification-sweep", page.list_complete ? "" : page.cursor || "");
}
