import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { closeTrackedSmithers, createTrackedSmithers as createSmithers } from "./fixtures/tracked-smithers.js";
import { createSmithersPostgres } from "smthrs";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";

afterAll(closeTrackedSmithers);

setDefaultTimeout(120_000);

const PG_URL = process.env.SMITHERS_TEST_PG_URL;

const cleanups: Array<() => Promise<void> | void> = [];

const usageReport = {
  accountLabel: "codex-work",
  provider: "codex",
  authMode: "subscription",
  source: "oauth",
  windows: [
    {
      id: "5h",
      label: "5-hour session",
      unit: "percent",
      usedPercent: 42,
      resetsAt: "2026-07-22T20:00:00.000Z",
    },
  ],
  planType: "pro",
  credits: { hasCredits: true, unlimited: false, balance: "12.50" },
  fetchedAt: "2026-07-22T15:00:00.000Z",
  stale: false,
  estimate: false,
} as const;

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

function makeDbPath(name: string) {
  return join(tmpdir(), `smithers-domain-api-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function createApi(backend: "sqlite" | "pglite" | "postgres") {
  const schemas = {
    result: z.object({ value: z.number() }),
    selection: z.object({ selected: z.string(), notes: z.string().nullable() }),
  };
  if (backend === "sqlite") {
    const dbPath = makeDbPath("sqlite");
    const api = createSmithers(schemas, { dbPath });
    cleanups.push(async () => {
      api.db.$client?.close?.();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    });
    return api;
  }
  if (backend === "pglite") {
    const api = await createSmithersPostgres(schemas, { provider: "pglite" });
    cleanups.push(() => api.close());
    return api;
  }
  if (!PG_URL) {
    throw new Error("SMITHERS_TEST_PG_URL is required for the postgres backend");
  }
  const pg = await import("pg");
  const admin = new pg.Client({ connectionString: PG_URL });
  const schema = `smithers_domain_api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const url = new URL(PG_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const api = await createSmithersPostgres(schemas, { provider: "postgres", connectionString: url.toString() });
  cleanups.push(async () => {
    await api.close();
    const drop = new pg.Client({ connectionString: PG_URL });
    await drop.connect();
    await drop.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await drop.end();
  });
  return api;
}

function createValueWorkflow(api: Awaited<ReturnType<typeof createApi>>) {
  return api.smithers((ctx: any) =>
    React.createElement(
      api.Workflow,
      { name: "domain-api-value" },
      React.createElement(
        api.Task,
        { id: "task1", output: api.outputs.result },
        { value: Number(ctx.input.value ?? 1) },
      ),
    ),
  );
}

function createSlowWorkflow(api: Awaited<ReturnType<typeof createApi>>) {
  return api.smithers(() =>
    React.createElement(
      api.Workflow,
      { name: "domain-api-slow" },
      React.createElement(api.Task, { id: "slow", output: api.outputs.result }, async () => {
        await sleep(5_000);
        return { value: 1 };
      }),
    ),
  );
}

function createApprovalWorkflow(api: Awaited<ReturnType<typeof createApi>>) {
  return api.smithers((ctx: any) => {
    const selection = ctx.outputMaybe("selection", { nodeId: "pick-plan" });
    return React.createElement(
      api.Workflow,
      { name: "domain-api-approval" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(api.Approval, {
          id: "pick-plan",
          mode: "select",
          output: api.outputs.selection,
          request: { title: "Pick a plan", summary: "Choose the best option." },
          options: [
            { key: "light", label: "Light" },
            { key: "balanced", label: "Balanced" },
          ],
          allowedScopes: ["approve"],
          allowedUsers: ["user:will"],
        }),
        selection
          ? React.createElement(
              api.Task,
              { id: "record", output: api.outputs.result },
              { value: selection.selected === "balanced" ? 2 : 1 },
            )
          : null,
      ),
    );
  });
}

async function bootGateway(backend: "sqlite" | "pglite" | "postgres") {
  const api = await createApi(backend);
  const gateway = new Gateway({
    auth: {
      mode: "token",
      tokens: {
        "operator-token": { role: "admin", scopes: ["*"], userId: "user:operator" },
        "reader-token": { role: "viewer", scopes: ["run:read"], userId: "user:reader" },
        "approver-token": { role: "approver", scopes: ["approve", "run:read"], userId: "user:will" },
      },
    },
  });
  gateway.register("value", createValueWorkflow(api));
  gateway.register("slow", createSlowWorkflow(api));
  gateway.register("approval", createApprovalWorkflow(api));
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

async function rpcRequest(baseUrl: string, method: string, params: Record<string, unknown>, token = "operator-token") {
  const response = await fetch(`${baseUrl}/v1/rpc/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = await response.json();
  return { response, json };
}

async function launchRun(baseUrl: string, workflow: string, input: Record<string, unknown> = {}) {
  const { response, json } = await apiRequest(baseUrl, "POST", "/v1/api/runs", { workflow, input });
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  expect(json.data.runId).toBeString();
  return json as { data: { runId: string }; seq?: number; txid?: string };
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "computedAt") continue;
      next[key] = stripVolatile(entry);
    }
    return next;
  }
  return value;
}

async function waitForRun(baseUrl: string, runId: string, status: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { response, json } = await apiRequest(baseUrl, "GET", `/v1/api/runs/${encodeURIComponent(runId)}`);
    if (response.status === 200 && json.data?.status === status) return json.data;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${status}`);
}

async function waitForListedRun(baseUrl: string, runId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { response, json } = await apiRequest(baseUrl, "GET", "/v1/api/runs?limit=50");
    const rows = Array.isArray(json.data) ? (json.data as Array<{ runId: string }>) : [];
    if (response.status === 200 && json.ok === true && rows.some((row) => row.runId === runId)) return rows;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${runId} to appear in the run list`);
}

async function waitForApproval(baseUrl: string, runId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { response, json } = await apiRequest(baseUrl, "GET", `/v1/api/approvals?runId=${encodeURIComponent(runId)}`);
    if (response.status === 200 && Array.isArray(json.data) && json.data.length > 0) return json.data[0];
    await sleep(25);
  }
  throw new Error(`Timed out waiting for approval on ${runId}`);
}

async function readSseUntil(baseUrl: string, predicate: (event: { event: string; data: any }) => boolean) {
  const abort = new AbortController();
  const response = await fetch(`${baseUrl}/v1/api/stream`, {
    headers: { authorization: "Bearer operator-token" },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const started = Date.now();
  try {
    for (;;) {
      if (Date.now() - started > 1_000) throw new Error("Timed out waiting for SSE event");
      const read = await reader.read();
      if (read.done) throw new Error("SSE stream closed");
      buffer += decoder.decode(read.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const event =
          part
            .split("\n")
            .find((line) => line.startsWith("event: "))
            ?.slice(7) ?? "message";
        const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
        const data = dataLine ? JSON.parse(dataLine.slice(6)) : null;
        const parsed = { event, data };
        if (predicate(parsed)) return parsed;
      }
    }
  } finally {
    abort.abort();
  }
}

const backends: Array<"sqlite" | "pglite" | "postgres"> = PG_URL
  ? ["sqlite", "pglite", "postgres"]
  : ["sqlite", "pglite"];

for (const backend of backends) {
  describe(`Gateway REST domain API (${backend})`, () => {
    test.skipIf(backend === "pglite" && process.platform === "win32")(
      "read routes delegate to the RPC internals",
      async () => {
        const { gateway, baseUrl } = await bootGateway(backend);
        (gateway as any).listUsageReports = async () => [usageReport];
        const launched = await launchRun(baseUrl, "value", { value: 7 });
        const runId = launched.data.runId;
        await waitForRun(baseUrl, runId, "finished");

        const pairs: Array<[string, string, string, Record<string, unknown>]> = [
          ["GET", "/v1/api/runs", "listRuns", {}],
          ["GET", `/v1/api/runs/${runId}`, "getRun", { runId }],
          ["GET", `/v1/api/runs/${runId}/tree`, "getDevToolsSnapshot", { runId }],
          ["GET", `/v1/api/runs/${runId}/token-usage`, "listRunTokenUsage", { runId }],
          ["GET", "/v1/api/workflows", "listWorkflows", {}],
          ["GET", "/v1/api/approvals", "listApprovals", {}],
          ["GET", "/v1/api/docs", "listDocs", {}],
          ["GET", "/v1/api/prompts", "listPrompts", {}],
          ["GET", "/v1/api/tickets", "listTickets", {}],
          ["GET", "/v1/api/memory-facts", "listMemoryFacts", {}],
          ["GET", "/v1/api/crons", "cronList", {}],
          ["GET", "/v1/api/accounts", "listAccounts", {}],
          ["GET", "/v1/api/usage", "listUsageReports", {}],
          ["GET", "/v1/api/schema-signature", "getSchemaSignature", {}],
          ["GET", `/v1/api/scores?runId=${runId}`, "listScores", { runId }],
          ["GET", `/v1/api/nodes/${runId}/task1/output`, "getNodeOutput", { runId, nodeId: "task1", iteration: 0 }],
        ];

        for (const [httpMethod, path, rpcMethod, params] of pairs) {
          const rest = await apiRequest(baseUrl, httpMethod, path);
          const rpc = await rpcRequest(baseUrl, rpcMethod, params);
          expect(rest.response.status, path).toBe(rpc.response.status);
          expect(rest.json.ok, path).toBe(rpc.json.ok);
          if (rest.json.ok) {
            expect(stripVolatile(rest.json.data), path).toEqual(stripVolatile(rpc.json.payload));
            if (path === "/v1/api/usage") {
              expect(rest.json.data).toEqual([usageReport]);
            }
          }
        }

        const events = await apiRequest(baseUrl, "GET", `/v1/api/events?runId=${runId}&limit=20`);
        expect(events.response.status).toBe(200);
        expect(events.json.ok).toBe(true);
        expect(Array.isArray(events.json.data)).toBe(true);
      },
      60_000,
    );

    test.skipIf(backend === "pglite" && process.platform === "win32")(
      "listRuns filters by workflow over the REST surface",
      async () => {
        const { baseUrl } = await bootGateway(backend);
        const a = await launchRun(baseUrl, "value", { value: 1 });
        const b = await launchRun(baseUrl, "value", { value: 2 });
        await waitForRun(baseUrl, a.data.runId, "finished");
        await waitForRun(baseUrl, b.data.runId, "finished");
        // A run of a different workflow that the ?workflow=value filter must drop.
        const slow = await launchRun(baseUrl, "slow");
        const unfilteredRows = await waitForListedRun(baseUrl, slow.data.runId);

        const filtered = await apiRequest(baseUrl, "GET", "/v1/api/runs?workflow=value&limit=50");
        expect(filtered.response.status).toBe(200);
        expect(filtered.json.ok).toBe(true);
        const rows = filtered.json.data as Array<{ runId: string; workflowKey: string }>;
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(rows.every((row) => row.workflowKey === "value")).toBe(true);
        expect(rows.some((row) => row.runId === slow.data.runId)).toBe(false);

        // Without the filter the slow run is present, proving the filter (not an
        // empty DB) is what excluded it above.
        const allIds = unfilteredRows.map((row) => row.runId);
        expect(allIds).toContain(slow.data.runId);

        await apiRequest(baseUrl, "POST", `/v1/api/runs/${slow.data.runId}/cancel`, {});
      },
      60_000,
    );

    test.skipIf(backend === "pglite" && process.platform === "win32")(
      "event history isolates one node iteration and attempt",
      async () => {
        const { gateway, baseUrl } = await bootGateway(backend);
        const launched = await launchRun(baseUrl, "value", { value: 7 });
        const runId = launched.data.runId;
        await waitForRun(baseUrl, runId, "finished");
        const resolved = await (gateway as any).resolveRun(runId);
        expect(resolved).toBeTruthy();
        for (const payload of [
          { nodeId: "task1", iteration: 0, attempt: 1, text: "older iteration" },
          { nodeId: "task1", iteration: 1, attempt: 1, text: "older attempt" },
          { nodeId: "task1", iteration: 1, attempt: 2, text: "target" },
          { nodeId: "other", iteration: 1, attempt: 2, text: "other node" },
        ]) {
          await resolved.adapter.insertEventWithNextSeq({
            runId,
            timestampMs: Date.now(),
            type: "NodeOutput",
            payloadJson: JSON.stringify(payload),
          });
        }

        const events = await apiRequest(
          baseUrl,
          "GET",
          `/v1/api/runs/${encodeURIComponent(runId)}/events?nodeId=task1&iteration=1&attempt=2&limit=120`,
        );
        expect(events.response.status).toBe(200);
        expect(events.json.data.map((event: any) => event.payload.text)).toEqual(["target"]);
      },
      60_000,
    );

    test.skipIf(backend === "pglite" && process.platform === "win32")(
      "listRuns REST offset matches the RPC page",
      async () => {
        const { baseUrl } = await bootGateway(backend);
        const first = await launchRun(baseUrl, "value", { value: 1 });
        const second = await launchRun(baseUrl, "value", { value: 2 });
        await waitForRun(baseUrl, first.data.runId, "finished");
        await waitForRun(baseUrl, second.data.runId, "finished");

        const unpaged = await apiRequest(baseUrl, "GET", "/v1/api/runs?limit=2");
        const rest = await apiRequest(baseUrl, "GET", "/v1/api/runs?limit=1&offset=1");
        const rpc = await rpcRequest(baseUrl, "listRuns", { filter: { limit: 1, offset: 1 } });
        expect(rest.response.status).toBe(200);
        expect(rest.json.ok).toBe(true);
        expect(rpc.response.status).toBe(200);
        expect(rpc.json.ok).toBe(true);
        expect((rest.json.data as Array<{ runId: string }>).map((row) => row.runId)).toEqual(
          (rpc.json.payload as Array<{ runId: string }>).map((row) => row.runId),
        );
        expect((rest.json.data as Array<{ runId: string }>)[0]?.runId).toBe(
          (unpaged.json.data as Array<{ runId: string }>)[1]?.runId,
        );
      },
      60_000,
    );

    test.skipIf(backend === "pglite" && process.platform === "win32")(
      "write routes return seq locally and invalidate SSE",
      async () => {
        const { baseUrl } = await bootGateway(backend);
        const eventPromise = readSseUntil(
          baseUrl,
          (event) =>
            event.event === "change" &&
            Array.isArray(event.data?.collections) &&
            event.data.collections.includes("runs"),
        );
        const launched = await launchRun(baseUrl, "value", { value: 3 });
        if (backend === "postgres") {
          expect(launched.txid).toMatch(/^\d+$/);
        } else {
          expect(launched.seq).toBeGreaterThan(0);
          expect(launched.txid).toBeUndefined();
        }
        await expect(eventPromise).resolves.toMatchObject({ event: "change" });

        const runId = launched.data.runId;
        await waitForRun(baseUrl, runId, "finished");
        const signal = await apiRequest(baseUrl, "POST", "/v1/api/signals", {
          runId,
          signalName: "release",
          payload: { ok: true },
        });
        expect(signal.response.status).toBe(200);
        expect(signal.json.ok).toBe(true);
        expect(backend === "postgres" ? signal.json.txid : signal.json.seq).toBeDefined();

        const resumed = await apiRequest(baseUrl, "POST", `/v1/api/runs/${runId}/resume`, {});
        expect(resumed.response.status).toBe(200);
        expect(resumed.json.ok).toBe(true);
        expect(backend === "postgres" ? resumed.json.txid : resumed.json.seq).toBeDefined();

        const slow = await launchRun(baseUrl, "slow");
        const cancelled = await apiRequest(baseUrl, "POST", `/v1/api/runs/${slow.data.runId}/cancel`, {});
        expect(cancelled.response.status).toBe(200);
        expect(cancelled.json.ok).toBe(true);
        expect(backend === "postgres" ? cancelled.json.txid : cancelled.json.seq).toBeDefined();
      },
      60_000,
    );

    test.skipIf(backend === "pglite" && process.platform === "win32")(
      "approval writes use the REST route and return the mutation ack",
      async () => {
        const { baseUrl } = await bootGateway(backend);
        const launched = await launchRun(baseUrl, "approval");
        const runId = launched.data.runId;
        await waitForRun(baseUrl, runId, "waiting-approval");
        await waitForApproval(baseUrl, runId);
        const decided = await apiRequest(
          baseUrl,
          "POST",
          `/v1/api/approvals/${encodeURIComponent(`${runId}:pick-plan:0`)}`,
          {
            runId,
            nodeId: "pick-plan",
            iteration: 0,
            approved: true,
            decision: { selected: "balanced", notes: null },
          },
          "approver-token",
        );
        expect(decided.response.status).toBe(200);
        expect(decided.json.ok).toBe(true);
        expect(backend === "postgres" ? decided.json.txid : decided.json.seq).toBeDefined();
        await waitForRun(baseUrl, runId, "finished");
      },
      60_000,
    );
  });
}

describe("Gateway usage reports", () => {
  test("maps GET /v1/api/usage and dispatches listUsageReports with the report shape", async () => {
    const gateway = new Gateway();
    (gateway as any).listUsageReports = async () => [usageReport];
    const route = gateway.apiRouteForRequest("GET", new URL("http://127.0.0.1/v1/api/usage"), {});
    expect(route).toEqual({
      method: "listUsageReports",
      params: expect.objectContaining({ fresh: undefined }),
    });

    const response = await gateway.routeRequest(
      { role: "admin", scopes: ["*"], transport: "http" },
      { type: "req", id: "usage-1", method: "listUsageReports", params: {} },
    );
    expect(response).toMatchObject({
      type: "res",
      id: "usage-1",
      ok: true,
      payload: [usageReport],
    });

    let responseBody = "";
    const res = {
      statusCode: 0,
      setHeader() {},
      end(value: string) {
        responseBody = value;
      },
    };
    await gateway.handleHttpApi(
      {
        method: "GET",
        url: "/v1/api/usage",
        headers: { host: "127.0.0.1" },
      } as any,
      res as any,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(responseBody)).toEqual({ ok: true, data: [usageReport] });
  });

  test("deduplicates polling, expires after 60 seconds, and supports fresh reads", async () => {
    const gateway = new Gateway({ auth: { mode: "token", tokens: {} } });
    const rawAccount = { label: "api", provider: "openai-api", apiKey: "secret" };
    const calls: Array<{ accounts: unknown[]; options: { fresh?: boolean } }> = [];
    (gateway as any).registeredAccountsFromRegistry = () => [rawAccount];
    (gateway as any).fetchUsageReports = async (accounts: unknown[], options: { fresh?: boolean }) => {
      calls.push({ accounts, options });
      return [usageReport];
    };

    const first = gateway.listUsageReports();
    const concurrent = gateway.listUsageReports();
    await expect(first).resolves.toEqual([usageReport]);
    await expect(concurrent).resolves.toEqual([usageReport]);
    await expect(gateway.listUsageReports()).resolves.toEqual([usageReport]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ accounts: [rawAccount], options: { fresh: false } });

    gateway.usageReportsCache!.cachedAtMs -= 60_001;
    await gateway.listUsageReports();
    await gateway.listUsageReports({ fresh: true });
    expect(calls.map((call) => call.options)).toEqual([{ fresh: false }, { fresh: false }, { fresh: true }]);
  });

  test("returns a synthetic unavailable report when the account registry is corrupt", async () => {
    const gateway = new Gateway({ auth: { mode: "token", tokens: {} } });
    let fetchCalls = 0;
    (gateway as any).registeredAccountsFromRegistry = () => {
      throw new Error("ACCOUNTS_FILE_INVALID: malformed JSON");
    };
    (gateway as any).fetchUsageReports = async () => {
      fetchCalls += 1;
      return [usageReport];
    };

    await expect(gateway.listUsageReports()).resolves.toEqual([
      {
        accountLabel: "accounts",
        provider: "codex",
        authMode: "subscription",
        source: "none",
        windows: [],
        fetchedAt: expect.any(String),
        stale: false,
        estimate: false,
        error: "ACCOUNTS_FILE_INVALID: malformed JSON",
      },
    ]);
    expect(fetchCalls).toBe(0);
  });

  test("clears a rejected single-flight request so the next call retries", async () => {
    const gateway = new Gateway({ auth: { mode: "token", tokens: {} } });
    let calls = 0;
    (gateway as any).registeredAccountsFromRegistry = () => [];
    (gateway as any).fetchUsageReports = async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider unavailable");
      return [usageReport];
    };

    const first = gateway.listUsageReports();
    const concurrent = gateway.listUsageReports();
    const settled = await Promise.allSettled([first, concurrent]);
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of settled) {
      expect(result.status === "rejected" ? result.reason : undefined).toMatchObject({
        message: "provider unavailable",
      });
    }
    expect(calls).toBe(1);
    expect((gateway as any).usageReportsInFlight).toBeNull();

    await expect(gateway.listUsageReports()).resolves.toEqual([usageReport]);
    expect(calls).toBe(2);
  });
});

describe("Gateway run token usage", () => {
  test("RPC and REST return every persisted event in sequence order beyond the client ring cap", async () => {
    const api = await createApi("sqlite");
    const workflow = createValueWorkflow(api);
    const gateway = new Gateway();
    gateway.register("value", workflow);
    cleanups.push(() => gateway.close());
    const adapter = (gateway as any).adapterForWorkflow(workflow);
    const runId = "token-usage-full-history";
    await adapter.insertRun({
      runId,
      workflowName: "domain-api-value",
      status: "finished",
      createdAtMs: 1,
      finishedAtMs: 2,
    });

    for (let index = 0; index < 1_026; index += 1) {
      await adapter.insertEventWithNextSeq({
        runId,
        timestampMs: 50_000 + index,
        type: "TokenUsageReported",
        payloadJson: JSON.stringify({
          nodeId: `node-${index}`,
          iteration: index,
          attempt: index + 1,
          model: "gpt-test",
          agent: "test-agent",
          inputTokens: index + 10,
          ...(index === 0 ? { freshInputTokens: 5, costUsd: 0.001 } : {}),
          outputTokens: index + 20,
          cacheReadTokens: index + 30,
          cacheWriteTokens: index + 40,
          reasoningTokens: index + 50,
          ...(index === 0 ? {} : { timestampMs: 90_000 + index }),
        }),
      });
    }

    const rpc = await gateway.routeRequest(
      { role: "admin", scopes: ["*"], transport: "http" },
      { type: "req", id: "usage-full", method: "listRunTokenUsage", params: { runId } },
    );
    expect(rpc).toMatchObject({ type: "res", id: "usage-full", ok: true });

    let responseBody = "";
    const res = {
      statusCode: 0,
      setHeader() {},
      end(value: string) {
        responseBody = value;
      },
    };
    await gateway.handleHttpApi(
      {
        method: "GET",
        url: `/v1/api/runs/${encodeURIComponent(runId)}/token-usage`,
        headers: { host: "127.0.0.1" },
      } as any,
      res as any,
    );
    const rest = JSON.parse(responseBody);
    expect(res.statusCode).toBe(200);
    expect(rest.data).toEqual((rpc as any).payload);
    expect((rpc as any).payload).toEqual({
      runId,
      events: expect.any(Array),
    });
    expect((rpc as any).payload.events).toHaveLength(1_026);
    expect((rpc as any).payload.events[0]).toEqual({
      nodeId: "node-0",
      iteration: 0,
      attempt: 1,
      model: "gpt-test",
      agent: "test-agent",
      inputTokens: 10,
      freshInputTokens: 5,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      reasoningTokens: 50,
      costUsd: 0.001,
      timestampMs: 50_000,
    });
    expect((rpc as any).payload.events.at(-1)).toEqual({
      nodeId: "node-1025",
      iteration: 1_025,
      attempt: 1_026,
      model: "gpt-test",
      agent: "test-agent",
      inputTokens: 1_035,
      freshInputTokens: 1_035,
      outputTokens: 1_045,
      cacheReadTokens: 1_055,
      cacheWriteTokens: 1_065,
      reasoningTokens: 1_075,
      costUsd: null,
      timestampMs: 91_025,
    });
  }, 60_000);
});

test.skipIf(Boolean(PG_URL))(
  "Gateway REST domain API postgres suite skipped because SMITHERS_TEST_PG_URL is not set",
  () => {
    expect(PG_URL).toBeUndefined();
  },
);

describe("Gateway REST domain API auth and SSE bounds", () => {
  test("auth rejects missing and insufficient scope, and trusted-proxy headers are honored", async () => {
    const { baseUrl } = await bootGateway("sqlite");
    const missing = await fetch(`${baseUrl}/v1/api/runs`);
    expect(missing.status).toBe(401);

    const insufficient = await apiRequest(
      baseUrl,
      "POST",
      "/v1/api/runs",
      { workflow: "value", input: {} },
      "reader-token",
    );
    expect(insufficient.response.status).toBe(403);
    expect(insufficient.json.error.requiredScope).toBe("run:write");

    const api = await createApi("sqlite");
    const trusted = new Gateway({
      auth: { mode: "trusted-proxy", trustedProxies: ["127.0.0.1", "::1"], defaultScopes: [] },
    });
    trusted.register("value", createValueWorkflow(api));
    const server = await trusted.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => trusted.close());
    const trustedBase = `http://127.0.0.1:${getPort(server)}`;
    const response = await fetch(`${trustedBase}/v1/api/runs`, {
      headers: { "x-user-id": "proxy-user", "x-user-scopes": "run:read", "x-user-role": "viewer" },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });

  test("SSE coalesces bursts and keeps a bounded replay buffer", async () => {
    const { gateway, baseUrl } = await bootGateway("sqlite");
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/v1/api/stream`, {
      headers: { authorization: "Bearer operator-token" },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const collect = async () => {
      const frames: any[] = [];
      const quietMs = 175;
      const started = Date.now();
      let lastChangeAt = 0;
      let pendingRead = reader.read();
      for (;;) {
        if (lastChangeAt > 0 && Date.now() - lastChangeAt > quietMs) return frames;
        if (Date.now() - started > 2_000) throw new Error("Timed out collecting coalesced SSE frames");
        const read = await Promise.race([pendingRead, sleep(25).then(() => null)]);
        if (!read) continue;
        pendingRead = reader.read();
        if (read.done) return frames;
        buffer += decoder.decode(read.value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const event = part
            .split("\n")
            .find((line) => line.startsWith("event: "))
            ?.slice(7);
          const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
          if (event === "change" && dataLine) {
            frames.push(JSON.parse(dataLine.slice(6)));
            lastChangeAt = Date.now();
          }
        }
      }
    };

    const collected = collect();
    const burst = Array.from({ length: 5 }, () => (gateway as any).queueApiInvalidation(["runs"]));
    await Promise.all(burst);
    const frames = await collected;
    abort.abort();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames.length).toBeLessThan(5);
    expect(frames.some((frame) => Array.isArray(frame.collections) && frame.collections.includes("runs"))).toBe(true);

    for (let index = 0; index < 300; index += 1) {
      await (gateway as any).queueApiInvalidation(["runs"]);
    }
    expect((gateway as any).apiStreamFrames.length).toBeLessThanOrEqual(256);
    expect((gateway as any).apiStreamFrameBytes).toBeLessThanOrEqual(64 * 1024);
  }, 60_000);

  test("SSE slow consumers stay bounded and receive reset before fresh frames", async () => {
    const { gateway } = await bootGateway("sqlite");
    const writes: string[] = [];
    const drainCallbacks: Array<() => void> = [];
    let writable = false;
    const subscriber = {
      id: "slow-consumer",
      closed: false,
      flushing: false,
      needsReset: false,
      queue: [] as Array<{ text: string; bytes: number }>,
      queueBytes: 0,
      res: {
        write(text: string) {
          writes.push(text);
          return writable;
        },
        once(event: string, callback: () => void) {
          if (event === "drain") drainCallbacks.push(callback);
        },
      },
    };

    (gateway as any).sendApiStreamFrame(subscriber, { seq: 1, collections: ["runs"] });
    for (let seq = 2; seq <= 320; seq += 1) {
      (gateway as any).sendApiStreamFrame(subscriber, { seq, collections: ["runs"] });
    }

    expect(subscriber.queue.length).toBeLessThanOrEqual(256);
    expect(subscriber.queueBytes).toBeLessThanOrEqual(64 * 1024);
    expect(subscriber.needsReset).toBe(true);

    writable = true;
    const drain = drainCallbacks.shift();
    expect(drain).toBeFunction();
    drain?.();

    const resetIndex = writes.findIndex((text) => text.includes("event: reset"));
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(writes.slice(resetIndex + 1).some((text) => text.includes("event: change"))).toBe(true);
    expect(subscriber.queue.length).toBe(0);
    expect(subscriber.queueBytes).toBe(0);
  }, 60_000);
});
