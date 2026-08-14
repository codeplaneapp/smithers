/**
 * The public edge of the stereOS demo.
 *
 * cloudflared publishes this process and nothing else. The Smithers gateway
 * listens on loopback with a bearer token that never leaves the host, so the
 * full RPC surface (hijack, browser sessions, cron, arbitrary workflow launch,
 * run diffs) is unreachable from the internet. This file is the entire public
 * API: four routes, each of which performs one whitelisted gateway call and
 * returns a hand-built projection.
 *
 * Enforced here:
 *   - only the three demo workflow ids may launch, and only with server-chosen input
 *   - at most MAX_CONCURRENT demo runs, with a visible queue
 *   - per-IP rate limit on starts
 *   - approval decisions require the unguessable token minted at start
 *   - runs are cancelled at RUN_TIMEOUT_MS
 *   - the response projection is built field by field, never by spreading engine rows
 */
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const GATEWAY_URL = process.env.STEREOS_GATEWAY_URL ?? "http://127.0.0.1:7331";
const GATEWAY_TOKEN = process.env.SMITHERS_API_KEY ?? "";
const PORT = Number(process.env.STEREOS_GUARD_PORT ?? 8787);
const UI_DIR = process.env.STEREOS_UI_DIR ?? join(import.meta.dir, "ui", "dist");

/**
 * The only workflows the public edge may launch, with the only input each may
 * receive and the node ids whose status the UI is allowed to see. Input is
 * chosen here, never taken from the request, so a visitor cannot steer a run.
 */
const ALLOWED = {
  hello: {
    input: () => ({ name: "stereOS" }),
    nodes: [{ id: "stereos-vm", label: "Run in the stereOS VM" }],
  },
  pipeline: {
    input: () => ({ text: "Smithers runs this inside a real VM" }),
    nodes: [
      { id: "prepare", label: "Prepare input on the host" },
      { id: "stereos-vm", label: "Compute in the stereOS VM" },
      { id: "report", label: "Summarize on the host" },
    ],
  },
  "approval-demo": {
    input: () => ({ change: "write approved-change.txt in the guest workspace" }),
    nodes: [
      { id: "gate", label: "Wait for a human decision" },
      { id: "stereos-vm", label: "Apply the change in the stereOS VM" },
    ],
  },
} as const;
type WorkflowId = keyof typeof ALLOWED;

const MAX_CONCURRENT = 2;
const MAX_QUEUE = 8;
const RUN_TIMEOUT_MS = 5 * 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_STARTS = 6;

/** Server-side run bookkeeping. `token` is never included in any projection. */
type DemoRun = {
  runId: string;
  workflow: WorkflowId;
  token: string;
  startedAtMs: number;
  clientIp: string;
  finishedAtMs?: number;
  lastStatus?: string;
};

const runs = new Map<string, DemoRun>();
const active = new Set<string>();
const queue: Array<{ ticket: string; workflow: WorkflowId; clientIp: string }> = [];
const starts = new Map<string, number[]>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });

/**
 * The gateway methods this process is allowed to call. The guard never
 * forwards a method name supplied by a request, so the public edge can reach
 * exactly these five and nothing else. Every one of them is called below; an
 * unused allowance is still an allowance, so the list stays exactly this size.
 */
const RPC_METHODS = ["launchRun", "getRun", "getNodeOutput", "submitApproval", "cancelRun"] as const;
type RpcMethod = (typeof RPC_METHODS)[number];

/** One whitelisted gateway RPC over loopback. Nothing here is reachable from outside. */
async function rpc<T>(method: RpcMethod, params: unknown): Promise<T> {
  const response = await fetch(`${GATEWAY_URL}/v1/rpc/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(GATEWAY_TOKEN ? { authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
    },
    body: JSON.stringify(params ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const frame = (await response.json().catch(() => null)) as {
    ok?: boolean;
    payload?: T;
    error?: { message?: string };
  } | null;
  if (!frame || frame.ok === false) {
    throw new Error(`gateway ${method} failed: ${frame?.error?.message ?? response.status}`);
  }
  return frame.payload as T;
}

/** Compare two secrets without leaking their common prefix through timing. */
function tokenMatches(expected: string, given: unknown) {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/**
 * Cloudflare sets cf-connecting-ip at its edge and overwrites any value the
 * client sent, and nothing but cloudflared can reach this loopback port, so
 * that header is the one trustworthy client identity here. A client-supplied
 * x-forwarded-for is deliberately NOT used as a fallback: honouring it would
 * let a caller mint a fresh rate-limit bucket per request.
 */
function clientIpOf(request: Request) {
  return request.headers.get("cf-connecting-ip") ?? "unattributed";
}

function rateLimited(ip: string) {
  const now = Date.now();
  const recent = (starts.get(ip) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  starts.set(ip, recent);
  return recent.length >= RATE_MAX_STARTS;
}

function noteStart(ip: string) {
  starts.set(ip, [...(starts.get(ip) ?? []), Date.now()]);
}

/** Statuses the engine reports for a run that will never progress again. */
const TERMINAL = new Set(["finished", "failed", "cancelled", "canceled", "error"]);

/**
 * Build the public view of a run. Every field is copied explicitly so engine
 * internals (workflow paths, env, provider config, host filesystem) cannot
 * leak by accident.
 */
function projectRun(run: DemoRun, row: Record<string, unknown>, nodes: PublicNode[], result: unknown) {
  return {
    runId: run.runId,
    workflow: run.workflow,
    status: typeof row.status === "string" ? row.status : "unknown",
    startedAtMs: run.startedAtMs,
    elapsedMs: (run.finishedAtMs ?? Date.now()) - run.startedAtMs,
    nodes,
    result,
  };
}

type PublicNode = { id: string; label: string; status: string };

/**
 * One node's public status, derived from whether the engine has stored its
 * output yet. The devtools snapshot carries the node tree but no per-node
 * status, so the output row is the authoritative signal.
 */
async function nodeStatus(runId: string, nodeId: string, runStatus: string): Promise<string> {
  try {
    const row = await rpc<{ status?: string }>("getNodeOutput", { runId, nodeId, iteration: 0 });
    if (row?.status === "produced") return "ok";
    if (row?.status === "failed" || row?.status === "error") return "failed";
  } catch {
    // No output row yet: the node has not produced.
  }
  if (runStatus === "waiting-approval") return nodeId === "gate" ? "waiting" : "pending";
  if (runStatus === "running") return "running";
  if (TERMINAL.has(runStatus) && runStatus !== "finished") return "cancelled";
  return "pending";
}

/**
 * The guest evidence a demo run produced. Only the child workflow's own output
 * row is forwarded, and only after it has been re-parsed from JSON, so nothing
 * the engine attached alongside it (workflow paths, config, schema) travels
 * with it.
 */
async function resultOf(runId: string): Promise<unknown> {
  try {
    const output = await rpc<{ status?: string; row?: unknown }>("getNodeOutput", {
      runId,
      nodeId: "stereos-vm",
      iteration: 0,
    });
    if (output?.status !== "produced") return null;
    return JSON.parse(JSON.stringify(output.row ?? null));
  } catch {
    return null;
  }
}

/** Cancel runs that outlive the hard timeout, then free their slot. */
async function reap() {
  const now = Date.now();
  for (const runId of [...active]) {
    const run = runs.get(runId);
    if (!run) {
      active.delete(runId);
      continue;
    }
    let status = run.lastStatus ?? "running";
    try {
      const row = await rpc<Record<string, unknown>>("getRun", { runId });
      status = typeof row.status === "string" ? row.status : status;
      run.lastStatus = status;
    } catch {
      // The gateway is briefly unavailable; keep the slot and retry next tick.
    }
    const expired = now - run.startedAtMs > RUN_TIMEOUT_MS;
    if (expired && !TERMINAL.has(status)) {
      await rpc("cancelRun", { runId }).catch(() => {});
      run.lastStatus = "cancelled";
      status = "cancelled";
    }
    // waiting-approval holds its slot: the visitor is mid-interaction.
    if (TERMINAL.has(status) || (expired && status === "waiting-approval")) {
      run.finishedAtMs ??= now;
      active.delete(runId);
    }
  }
  // Drop bookkeeping for runs nobody is polling any more.
  for (const [runId, run] of runs) {
    if (run.finishedAtMs && now - run.finishedAtMs > 30 * 60_000) runs.delete(runId);
  }
  await drain();
}

/** Promote queued tickets into real launches as slots free up. */
async function drain() {
  while (active.size < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const pending = tickets.get(next.ticket);
    if (!pending) continue;
    try {
      const launched = await launch(next.workflow, next.clientIp);
      pending.resolve(launched);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    tickets.delete(next.ticket);
  }
}

const tickets = new Map<string, { resolve: (v: DemoRun) => void; reject: (e: Error) => void }>();

/** Launch one allowlisted workflow and take a concurrency slot. */
async function launch(workflow: WorkflowId, clientIp: string): Promise<DemoRun> {
  const response = await rpc<{ runId: string }>("launchRun", {
    workflow,
    input: ALLOWED[workflow].input(),
    options: { startedBy: { harness: "stereos-site-demo" } },
  });
  const run: DemoRun = {
    runId: response.runId,
    workflow,
    // 256 bits from the CSPRNG. The only authority over this run's approval.
    token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""),
    startedAtMs: Date.now(),
    clientIp,
  };
  runs.set(run.runId, run);
  active.add(run.runId);
  return run;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/** Serve the built UI. Paths are resolved inside UI_DIR and never above it. */
async function serveUi(pathname: string) {
  // Decode first: an escaped traversal such as %2e%2e must be rejected by the
  // same check as a literal one.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relative.includes("..") || relative.includes("\0") || relative.startsWith("/")) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(join(UI_DIR, relative));
  if (await file.exists()) {
    const dot = relative.lastIndexOf(".");
    return new Response(file, {
      headers: {
        "content-type": MIME[relative.slice(dot)] ?? "application/octet-stream",
        "cache-control": relative === "index.html" ? "no-store" : "public, max-age=300",
      },
    });
  }
  const index = Bun.file(join(UI_DIR, "index.html"));
  if (await index.exists()) return new Response(index, { headers: { "content-type": MIME[".html"] } });
  return new Response("not found", { status: 404 });
}

setInterval(() => {
  reap().catch(() => {});
}, 2_000);

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return json({}, 204);

    if (path === "/api/health") {
      return json({
        ok: true,
        workflows: Object.keys(ALLOWED),
        active: active.size,
        capacity: MAX_CONCURRENT,
        queued: queue.length,
      });
    }

    if (path === "/api/runs" && request.method === "POST") {
      const ip = clientIpOf(request);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const workflow = (body as { workflow?: unknown })?.workflow;
      if (typeof workflow !== "string" || !(workflow in ALLOWED)) {
        return json({ error: "unknown workflow", allowed: Object.keys(ALLOWED) }, 400);
      }
      if (rateLimited(ip)) return json({ error: "rate limited: 6 runs per 10 minutes" }, 429);
      if (active.size >= MAX_CONCURRENT && queue.length >= MAX_QUEUE) {
        return json({ error: "the demo queue is full; try again shortly" }, 503);
      }
      noteStart(ip);
      const id = workflow as WorkflowId;
      try {
        if (active.size < MAX_CONCURRENT) {
          const run = await launch(id, ip);
          return json({ runId: run.runId, token: run.token, workflow: id, queuePosition: 0 });
        }
        const ticket = crypto.randomUUID();
        const position = queue.length + 1;
        const waited = new Promise<DemoRun>((resolve, reject) => {
          tickets.set(ticket, { resolve, reject });
          queue.push({ ticket, workflow: id, clientIp: ip });
          setTimeout(() => {
            if (tickets.delete(ticket)) reject(new Error("timed out waiting for a demo slot"));
          }, 90_000);
        });
        const run = await waited;
        return json({ runId: run.runId, token: run.token, workflow: id, queuePosition: position });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "failed to start the run" }, 502);
      }
    }

    const runMatch = path.match(/^\/api\/runs\/([0-9a-fA-F-]{36})$/);
    if (runMatch && request.method === "GET") {
      const run = runs.get(runMatch[1]!);
      if (!run) return json({ error: "unknown run" }, 404);
      try {
        const row = await rpc<Record<string, unknown>>("getRun", { runId: run.runId });
        const status = typeof row.status === "string" ? row.status : (run.lastStatus ?? "unknown");
        run.lastStatus = status;
        if (TERMINAL.has(status)) run.finishedAtMs ??= Date.now();
        const nodes = await Promise.all(
          ALLOWED[run.workflow].nodes.map(async (node) => ({
            id: node.id,
            label: node.label,
            status: await nodeStatus(run.runId, node.id, status),
          })),
        );
        const result = status === "finished" ? await resultOf(run.runId) : null;
        return json(projectRun(run, row, nodes, result));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "failed to read the run" }, 502);
      }
    }

    const approveMatch = path.match(/^\/api\/runs\/([0-9a-fA-F-]{36})\/approval$/);
    if (approveMatch && request.method === "POST") {
      const run = runs.get(approveMatch[1]!);
      if (!run) return json({ error: "unknown run" }, 404);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const { token, approved } = (body ?? {}) as { token?: unknown; approved?: unknown };
      if (!tokenMatches(run.token, token)) return json({ error: "invalid run token" }, 403);
      if (run.workflow !== "approval-demo") return json({ error: "this run has no approval gate" }, 400);
      try {
        await rpc("submitApproval", {
          runId: run.runId,
          nodeId: "gate",
          approved: approved === true,
          decision: { approved: approved === true, note: "decided from custom-sandbox.smithers.sh" },
        });
        return json({ ok: true, approved: approved === true });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "failed to submit the decision" }, 502);
      }
    }

    // Everything that is not one of the four routes above is a static asset
    // request. Only GET/HEAD reach the UI, so a POST to a gateway-shaped path
    // such as /v1/rpc/<method> is rejected rather than answered by the SPA
    // fallback, which would read like a passthrough.
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "not found" }, 404);
    if (path.startsWith("/api/") || path.startsWith("/v1/")) return json({ error: "not found" }, 404);
    return serveUi(path);
  },
});

console.log(`stereos guard listening on 127.0.0.1:${PORT}, gateway ${GATEWAY_URL}, ui ${UI_DIR}`);
