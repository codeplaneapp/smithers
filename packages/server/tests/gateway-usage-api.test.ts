import { afterEach, expect, test } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { writeAccounts } from "@smithers-orchestrator/accounts/writeAccounts";
import { writeUsageCache } from "@smithers-orchestrator/usage/usageCache";
import { Gateway } from "../src/gateway.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function gatewayForReads() {
  const dbPath = join(tmpdir(), `smithers-usage-api-${Date.now()}-${Math.random()}.db`);
  const api = createSmithers({ result: z.object({ ok: z.boolean() }) }, { dbPath });
  const gateway = new Gateway({ auth: { mode: "token", tokens: { admin: { role: "admin", scopes: ["*"], userId: "admin" }, reader: { role: "viewer", scopes: ["run:read"], userId: "reader" }, account: { role: "viewer", scopes: ["account:read"], userId: "account" } } } });
  gateway.register("usage-test", api.smithers(() => React.createElement(api.Workflow, { name: "usage-test" }, React.createElement(api.Task, { id: "task", output: api.outputs.result }, { ok: true }))));
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  cleanups.push(async () => { await gateway.close(); api.db.$client?.close?.(); rmSync(dbPath, { force: true }); rmSync(`${dbPath}-shm`, { force: true }); rmSync(`${dbPath}-wal`, { force: true }); });
  return { base: `http://127.0.0.1:${address.port}`, gateway };
}
async function get(base: string, path: string, token?: string) {
  const response = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { response, json: await response.json() as any };
}

test("token usage route protects reads and reports unknown runs honestly", async () => {
  const { base } = await gatewayForReads();
  const unauthenticated = await get(base, "/v1/api/runs/missing/token-usage");
  expect(unauthenticated.response.status).toBe(401);
  const missing = await get(base, "/v1/api/runs/missing/token-usage", "reader");
  expect(missing.response.status).toBe(404);
  expect(missing.json.ok).toBe(false);
});

test("account usage route has an account scope", async () => {
  const { base } = await gatewayForReads();
  const forbidden = await get(base, "/v1/api/usage", "reader");
  expect(forbidden.response.status).toBe(403);
  expect(forbidden.json.ok).toBe(false);
});

test("token usage route aggregates persisted events for a viewer without exposing them", async () => {
  const { base, gateway } = await gatewayForReads();
  const launched = await fetch(`${base}/v1/api/runs`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ workflow: "usage-test", input: {} }) });
  const runId = (await launched.json() as any).data.runId;
  const adapter = gateway.adapterForWorkflow((gateway.workflows.get("usage-test") as any).workflow);
  await adapter.insertEventWithNextSeq({ runId, timestampMs: 1_000, type: "TokenUsageReported", payloadJson: JSON.stringify({ model: "future", agent: "codex", inputTokens: 12, outputTokens: 3, timestampMs: 1_000, costUsd: 0.25 }) });
  const result = await get(base, `/v1/api/runs/${encodeURIComponent(runId)}/token-usage`, "reader");
  expect(result.response.status).toBe(200);
  expect(result.json.data.totals).toMatchObject({ inputTokens: 12, outputTokens: 3, eventCount: 1, costUsd: 0.25 });
  expect(result.json.data.groups[0]).toMatchObject({ engine: "codex", model: "future", priced: true });
  expect(result.json.data.events).toBeUndefined();
});

test("account usage route returns identity-matched cached reports", async () => {
  const home = mkdtempSync(join(tmpdir(), "smithers-usage-home-"));
  const previous = process.env.SMITHERS_HOME;
  process.env.SMITHERS_HOME = home;
  cleanups.push(() => { if (previous === undefined) delete process.env.SMITHERS_HOME; else process.env.SMITHERS_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const now = Date.now(); const configDir = join(home, "codex");
  writeAccounts({ version: 1, accounts: [{ provider: "codex", label: "work", configDir }] }, process.env);
  writeUsageCache({ version: 1, entries: { work: { identity: { provider: "codex", configDir }, report: { accountLabel: "work", provider: "codex", fetchedAt: new Date(now).toISOString(), windows: [{ label: "five hour", usedPercent: 22, resetsAt: new Date(now + 3_600_000).toISOString() }] } } } }, process.env);
  const { base } = await gatewayForReads();
  const result = await get(base, "/v1/api/usage", "account");
  expect(result.response.status).toBe(200);
  expect(result.json.data[0]).toMatchObject({ accountLabel: "work", stale: true });
});
