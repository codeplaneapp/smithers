import { spawn, execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

/**
 * Boot the real seed Gateway and seed it with deterministic runs/approvals via
 * the real `launchRun` RPC (no mocks). Blocks until the seeded data is visible
 * through `listRuns`/`listApprovals`, so every spec starts against a populated
 * gateway. The gateway pid is recorded for `globalTeardown`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..", "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.SMITHERS_E2E_GATEWAY_PORT ?? "7331");
const CONCIERGE_PORT = Number(process.env.SMITHERS_CONCIERGE_PORT ?? "5179");
const GW = `http://${HOST}:${PORT}`;
const CONCIERGE = `http://${HOST}:${CONCIERGE_PORT}`;

function freePort(port: number): void {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (pids) execSync(`kill -9 ${pids.split("\n").join(" ")}`, { stdio: "ignore" });
  } catch {
    // nothing listening — fine
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${GW}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const frame = (await res.json()) as { ok?: boolean; payload?: unknown; error?: { message?: string } };
  if (!frame.ok) throw new Error(frame.error?.message ?? `RPC ${method} failed`);
  return frame.payload;
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {
      // keep polling
    }
    await sleep(500);
  }
  throw new Error(`[e2e] timed out waiting for ${label}`);
}

export default async function globalSetup(): Promise<void> {
  freePort(PORT);
  freePort(CONCIERGE_PORT);

  const child = spawn("bun", [resolve(here, "seedGateway.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
      SMITHERS_HOME: resolve(here, "fixtures", "smithers-home"),
    },
    stdio: "inherit",
    detached: true,
  });
  child.unref();
  writeFileSync(resolve(here, ".gateway.pid"), String(child.pid ?? ""));

  // The concierge (real-LLM chat backend). It inherits the LLM credential env
  // (CEREBRAS_API_KEY / OPENAI_API_KEY / CODEX_ACCESS_TOKEN). Locally the chat
  // specs run against the real model (no mocks); in CI no credential is set, so
  // the concierge returns 500 on /api/chat and the chat specs skip themselves.
  const concierge = spawn("bun", [resolve(appDir, "concierge", "server.ts")], {
    env: {
      ...process.env,
      SMITHERS_CONCIERGE_PORT: String(CONCIERGE_PORT),
      SMITHERS_GATEWAY_PROXY_TARGET: GW,
    },
    stdio: "inherit",
    detached: true,
  });
  concierge.unref();
  writeFileSync(resolve(here, ".concierge.pid"), String(concierge.pid ?? ""));

  // 1. Wait for the gateway + concierge to listen.
  await waitFor("gateway /health", async () => {
    const res = await fetch(`${GW}/health`);
    return res.ok;
  });
  await waitFor("concierge /health", async () => {
    const res = await fetch(`${CONCIERGE}/health`);
    return res.ok;
  });

  // 2. Seed runs via the real RPC: two completed task runs plus several pending
  // approvals (margin so the approve + deny specs and any retries always find a
  // gate to act on).
  const scoredRunIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const launched = (await rpc("launchRun", { workflow: "e2e-task" })) as { runId?: unknown };
    if (typeof launched.runId === "string") scoredRunIds.push(launched.runId);
  }
  for (let i = 0; i < 4; i += 1) {
    await rpc("launchRun", { workflow: "e2e-approval" });
  }

  // 3. Block until the seeded data is queryable, so specs never race the seed.
  await waitFor("seeded runs (>=6)", async () => {
    const runs = (await rpc("listRuns", {})) as unknown[];
    return Array.isArray(runs) && runs.length >= 6;
  });
  await waitFor("pending approvals (>=4)", async () => {
    const approvals = (await rpc("listApprovals", {})) as unknown[];
    return Array.isArray(approvals) && approvals.length >= 4;
  });
  await waitFor("seeded scores for task runs", async () => {
    if (scoredRunIds.length !== 2) return false;
    const rows = await Promise.all(
      scoredRunIds.map((runId) => rpc("listScores", { runId }) as Promise<unknown[]>),
    );
    return rows.every((scores) => Array.isArray(scores) && scores.length >= 2);
  });

  // Seed two real ticket documents through the same gateway mutations the
  // Tickets surface uses. Browser coverage can then exercise list/search/edit
  // against persisted rows before creating and deleting its own ticket.
  await rpc("createTicket", {
    path: "e2e-auth-rotation",
    content: "# Rotate auth tokens\n\nCover the token refresh path with rendered browser tests.",
    status: "in-progress",
  });
  await rpc("createTicket", {
    path: "e2e-release-checklist",
    content: "# Release checklist\n\nVerify the real gateway surfaces before publishing.",
    status: "todo",
  });
  await waitFor("seeded tickets", async () => {
    const rows = (await rpc("listTickets", {})) as unknown[];
    return Array.isArray(rows) && rows.length >= 2;
  });

  console.log("[e2e] gateway seeded: 6 runs, 4 pending approvals, scores, memory, accounts, prompts, tickets");
}
