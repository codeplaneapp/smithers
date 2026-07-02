import type { BugWorkerEnv } from "./env.ts";
import { bugReportSchema } from "./bugReportSchema.ts";
import { newBugId } from "./newBugId.ts";

export type { BugWorkerEnv, BugKv } from "./env.ts";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const RATE_LIMIT_PER_HOUR = 20;

export interface BugWorkerDeps {
  now: () => number;
}

/** Permissive on purpose: the CLI is the main client, but anyone may POST. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, x-bug-admin",
  "access-control-max-age": "86400",
} as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function checkRateLimit(env: BugWorkerEnv, ip: string, now: number): Promise<boolean> {
  const hourBucket = Math.floor(now / 3_600_000);
  const key = `ratelimit:${ip}:${hourBucket}`;
  const count = Number((await env.BUGS.get(key)) ?? "0");
  if (count >= RATE_LIMIT_PER_HOUR) return false;
  await env.BUGS.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

async function handlePostBug(request: Request, env: BugWorkerEnv, now: number): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    return json(413, { error: "payload too large", maxBytes: MAX_PAYLOAD_BYTES });
  }

  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
  if (!(await checkRateLimit(env, ip, now))) {
    return json(429, { error: "rate limit exceeded (20 reports per hour per IP)" });
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_PAYLOAD_BYTES) {
    return json(413, { error: "payload too large", maxBytes: MAX_PAYLOAD_BYTES });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  const result = bugReportSchema.safeParse(parsed);
  if (!result.success) {
    return json(400, { error: "invalid bug report", issues: result.error.issues });
  }

  const id = newBugId(now);
  const record = { id, receivedAt: new Date(now).toISOString(), report: result.data };
  await env.BUGS.put(`bug:${id}`, JSON.stringify(record));

  const base = (env.PUBLIC_BASE_URL ?? "https://bug.smithers.sh").replace(/\/$/, "");
  return json(201, { id, url: `${base}/api/bugs/${id}` });
}

async function handleGetBug(request: Request, env: BugWorkerEnv, id: string): Promise<Response> {
  const provided = request.headers.get("x-bug-admin") ?? "";
  if (!env.BUG_ADMIN_TOKEN || !timingSafeStringEqual(provided, env.BUG_ADMIN_TOKEN)) {
    return json(401, { error: "x-bug-admin header required" });
  }
  const stored = await env.BUGS.get(`bug:${id}`);
  if (stored === null) return json(404, { error: "not found" });
  return new Response(stored, {
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

/**
 * Build the worker module with explicit deps; tests inject a controllable
 * clock. The default export uses the real clock.
 */
export function createBugWorker(overrides?: Partial<BugWorkerDeps>) {
  const deps: BugWorkerDeps = { now: () => Date.now(), ...overrides };
  return {
    async fetch(request: Request, env: BugWorkerEnv): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/bugs") {
        return handlePostBug(request, env, deps.now());
      }
      const match = url.pathname.match(/^\/api\/bugs\/([A-Za-z0-9_-]+)$/);
      if (request.method === "GET" && match) {
        return handleGetBug(request, env, match[1]!);
      }
      return json(404, { error: "not found" });
    },
  };
}

export default createBugWorker();
