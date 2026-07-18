/**
 * REST coverage for the monitor's decisions ledger route:
 *
 * - GET /v1/api/runs/:id/decisions — durable approvals, ask-human requests,
 *   and provenance-stamped memory facts merged into one chronological ledger
 *   (the Decisions & deviations panel's data source).
 *
 * Real gateway, real sqlite DB, no mocks — same pattern as
 * gateway-node-states-retry.test.ts. The merge/tolerant-reader edge cases live
 * in listRunDecisionsRoute.test.ts; this file proves routing, the REST
 * envelope, run:read authorization, HTTP error mapping, and that a real
 * approval lifecycle (requested → approved with a selected option) flows
 * through to the ledger.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";

setDefaultTimeout(120_000);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function getPort(server: import("node:http").Server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Gateway server did not expose a port");
  return addr.port;
}

function createApi() {
  const schemas = { selection: z.object({ selected: z.string(), notes: z.string().nullable() }) };
  const dbPath = join(tmpdir(), `smithers-run-decisions-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const api = createSmithers(schemas, { dbPath });
  cleanups.push(async () => {
    api.db.$client?.close?.();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });
  return api;
}

async function bootGateway() {
  const api = createApi();
  const gateway = new Gateway({
    auth: {
      mode: "token",
      tokens: {
        "operator-token": { role: "admin", scopes: ["*"], userId: "user:operator" },
        "reader-token": { role: "viewer", scopes: ["run:read"], userId: "user:reader" },
        "cron-token": { role: "viewer", scopes: ["cron:read"], userId: "user:cron" },
      },
    },
  });
  // A select-mode approval gate so the decided entry carries a structured
  // decision (the selected option) end to end.
  gateway.register(
    "gated",
    api.smithers(() =>
      React.createElement(
        api.Workflow,
        { name: "decisions-gated" },
        React.createElement(api.Approval, {
          id: "pick-plan",
          mode: "select",
          output: api.outputs.selection,
          request: { title: "Pick a plan", summary: "Choose the best option." },
          options: [
            { key: "light", label: "Light" },
            { key: "balanced", label: "Balanced" },
          ],
        }),
      ),
    ),
  );
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => gateway.close());
  return { gateway, baseUrl: `http://127.0.0.1:${getPort(server)}` };
}

async function apiRequest(baseUrl: string, method: string, path: string, body?: unknown, token = "operator-token") {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { response, json };
}

async function launchRun(baseUrl: string, workflow: string) {
  const { response, json } = await apiRequest(baseUrl, "POST", "/v1/api/runs", { workflow, input: {} });
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  return json.data.runId as string;
}

type Ledger = { runId: string; entries: Array<Record<string, any>>; counts: Record<string, number> };

async function decisionsUntil(baseUrl: string, runId: string, predicate: (data: Ledger) => boolean) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { response, json } = await apiRequest(baseUrl, "GET", `/v1/api/runs/${encodeURIComponent(runId)}/decisions`);
    if (response.status === 200 && json.ok === true && predicate(json.data)) return json.data as Ledger;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${runId} decisions to reach the expected state`);
}

test("decisions ledger follows a real approval from requested to approved with its selected option", async () => {
  const { baseUrl } = await bootGateway();
  const runId = await launchRun(baseUrl, "gated");

  // The pending approval surfaces as a requested ledger entry.
  const pending = await decisionsUntil(baseUrl, runId, (data) =>
    data.entries.some((entry) => entry.kind === "approval" && entry.status === "requested"));
  expect(pending.runId).toBe(runId);
  expect(pending.counts.pending).toBe(1);
  expect(pending.counts.approvals).toBe(1);
  const requested = pending.entries.find((entry) => entry.kind === "approval")!;
  expect(requested.title).toBe("Pick a plan");
  expect(requested.nodeId).toBe("pick-plan");
  expect(requested.resolution).toBeNull();

  // Decide through the real submitApproval REST route. The approval row can
  // land before the node reaches waiting-approval, so retry until accepted.
  let decidedOk = false;
  for (let attempt = 0; attempt < 200 && !decidedOk; attempt += 1) {
    const decide = await apiRequest(baseUrl, "POST", `/v1/api/approvals/${encodeURIComponent(`${runId}:pick-plan:0`)}`, {
      approved: true,
      decision: { selected: "balanced", notes: "best fit" },
    });
    decidedOk = decide.response.status === 200 && decide.json.ok === true;
    if (!decidedOk) await sleep(25);
  }
  expect(decidedOk).toBe(true);

  const decided = await decisionsUntil(baseUrl, runId, (data) =>
    data.entries.some((entry) => entry.kind === "approval" && entry.status === "approved"));
  const approved = decided.entries.find((entry) => entry.kind === "approval" && entry.status === "approved")!;
  expect(approved.resolution?.value).toEqual({ selected: "balanced", notes: "best fit" });
  expect(approved.detail?.decision).toEqual({ selected: "balanced", notes: "best fit" });
  expect(decided.counts.pending).toBe(0);

  // Reads are run:read — the viewer token sees the same ledger.
  const reader = await apiRequest(baseUrl, "GET", `/v1/api/runs/${encodeURIComponent(runId)}/decisions`, undefined, "reader-token");
  expect(reader.response.status).toBe(200);
  expect(reader.json.ok).toBe(true);
  expect(reader.json.data.counts.approvals).toBe(1);
});

test("decisions ledger enforces run:read scope and honest HTTP error mapping", async () => {
  const { baseUrl } = await bootGateway();
  const runId = await launchRun(baseUrl, "gated");

  // A token without run:read is FORBIDDEN.
  const forbidden = await apiRequest(baseUrl, "GET", `/v1/api/runs/${encodeURIComponent(runId)}/decisions`, undefined, "cron-token");
  expect(forbidden.response.status).toBe(403);
  expect(forbidden.json.ok).toBe(false);

  // A malformed run id is rejected before any run resolution.
  const invalid = await apiRequest(baseUrl, "GET", "/v1/api/runs/NOT-A-RUN-ID/decisions");
  expect(invalid.response.status).toBe(400);
  expect(invalid.json.ok).toBe(false);

  // An unknown run answers NOT_FOUND, not an empty ledger.
  const missing = await apiRequest(baseUrl, "GET", "/v1/api/runs/does-not-exist/decisions");
  expect(missing.response.status).toBe(404);
  expect(missing.json.ok).toBe(false);
});
