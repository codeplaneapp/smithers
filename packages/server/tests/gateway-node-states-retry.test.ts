/**
 * REST coverage for the monitor's two operator routes:
 *
 * - GET  /v1/api/runs/:id/node-states — the run's _smithers_nodes rows with
 *   latest-attempt timing attached (the Timeline view's data source).
 * - POST /v1/api/runs/:id/nodes/:nodeId/retry — the retryTask RPC: reset the
 *   node + dependents via the same time-travel machinery as
 *   `smithers retry-task`, then resume the run through the resumeRun path.
 *
 * Real gateway, real sqlite DB, no mocks — same pattern as
 * gateway-domain-api.test.ts.
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
  const schemas = { result: z.object({ value: z.number() }) };
  const dbPath = join(tmpdir(), `smithers-node-states-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
      },
    },
  });
  // Two sequential tasks so retryTask has a dependent to reset.
  gateway.register(
    "two-step",
    api.smithers((ctx: any) =>
      React.createElement(
        api.Workflow,
        { name: "node-states-two-step" },
        React.createElement(
          api.Sequence,
          null,
          React.createElement(
            api.Task,
            { id: "first", output: api.outputs.result },
            {
              value: Number(ctx.input.value ?? 1),
            },
          ),
          React.createElement(
            api.Task,
            { id: "second", output: api.outputs.result },
            {
              value: Number(ctx.input.value ?? 1) + 1,
            },
          ),
        ),
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

async function launchRun(baseUrl: string, workflow: string, input: Record<string, unknown> = {}) {
  const { response, json } = await apiRequest(baseUrl, "POST", "/v1/api/runs", { workflow, input });
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  return json.data.runId as string;
}

async function waitForRun(baseUrl: string, runId: string, status: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { response, json } = await apiRequest(baseUrl, "GET", `/v1/api/runs/${encodeURIComponent(runId)}`);
    if (response.status === 200 && json.data?.status === status) return json.data;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${status}`);
}

test("node-states returns per-(node, iteration) rows with latest-attempt timing", async () => {
  const { baseUrl } = await bootGateway();
  const runId = await launchRun(baseUrl, "two-step", { value: 7 });
  await waitForRun(baseUrl, runId, "finished");

  const { response, json } = await apiRequest(baseUrl, "GET", `/v1/api/runs/${encodeURIComponent(runId)}/node-states`);
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  const rows = json.data as Array<Record<string, unknown>>;
  expect(Array.isArray(rows)).toBe(true);
  const first = rows.find((row) => row.nodeId === "first");
  const second = rows.find((row) => row.nodeId === "second");
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  for (const row of [first!, second!]) {
    expect(row.iteration).toBe(0);
    expect(row.state).toBe("finished");
    expect(typeof row.updatedAtMs).toBe("number");
    expect(typeof row.startedAtMs).toBe("number");
    expect(typeof row.finishedAtMs).toBe("number");
    expect((row.finishedAtMs as number) >= (row.startedAtMs as number)).toBe(true);
  }

  // Reads are run:read — the viewer token sees the same rows.
  const reader = await apiRequest(
    baseUrl,
    "GET",
    `/v1/api/runs/${encodeURIComponent(runId)}/node-states`,
    undefined,
    "reader-token",
  );
  expect(reader.response.status).toBe(200);
  expect(reader.json.ok).toBe(true);

  const missing = await apiRequest(baseUrl, "GET", "/v1/api/runs/does-not-exist/node-states");
  expect(missing.response.status).toBe(404);
  expect(missing.json.ok).toBe(false);
});

test("retryTask resets the node + dependents and resumes through the run lifecycle", async () => {
  const { baseUrl } = await bootGateway();
  const runId = await launchRun(baseUrl, "two-step", { value: 3 });
  await waitForRun(baseUrl, runId, "finished");

  const retry = await apiRequest(
    baseUrl,
    "POST",
    `/v1/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent("first")}/retry`,
    { iteration: 0 },
  );
  expect(retry.response.status).toBe(200);
  expect(retry.json.ok).toBe(true);
  expect(retry.json.data.status).toBe("retry_requested");
  expect(retry.json.data.runId).toBe(runId);
  expect(retry.json.data.nodeId).toBe("first");
  // Resetting the first task also resets the task that ran after it.
  expect(retry.json.data.resetNodes).toContain("first");
  expect(retry.json.data.resetNodes).toContain("second");

  // The gateway resumes the run in-process (same path as resumeRun): it must
  // re-execute both tasks and settle back to finished with real output.
  await waitForRun(baseUrl, runId, "finished");
  const output = await apiRequest(baseUrl, "GET", `/v1/api/nodes/${encodeURIComponent(runId)}/second/output`);
  expect(output.response.status).toBe(200);
  expect(output.json.ok).toBe(true);
  expect(output.json.data.row.value).toBe(4);

  const states = await apiRequest(baseUrl, "GET", `/v1/api/runs/${encodeURIComponent(runId)}/node-states`);
  const rows = states.json.data as Array<Record<string, unknown>>;
  for (const nodeId of ["first", "second"]) {
    const row = rows.find((entry) => entry.nodeId === nodeId);
    expect(row?.state).toBe("finished");
  }
});

test("retryTask enforces run:write scope and honest error codes", async () => {
  const { baseUrl } = await bootGateway();
  const runId = await launchRun(baseUrl, "two-step", {});
  await waitForRun(baseUrl, runId, "finished");

  // run:read cannot reset tasks.
  const forbidden = await apiRequest(
    baseUrl,
    "POST",
    `/v1/api/runs/${encodeURIComponent(runId)}/nodes/first/retry`,
    { iteration: 0 },
    "reader-token",
  );
  expect(forbidden.response.status).toBe(403);
  expect(forbidden.json.ok).toBe(false);

  // Unknown node and unknown run both answer NOT_FOUND, not a silent reset.
  const missingNode = await apiRequest(
    baseUrl,
    "POST",
    `/v1/api/runs/${encodeURIComponent(runId)}/nodes/nope/retry`,
    {},
  );
  expect(missingNode.response.status).toBe(404);
  expect(missingNode.json.ok).toBe(false);

  const missingRun = await apiRequest(baseUrl, "POST", "/v1/api/runs/does-not-exist/nodes/first/retry", {});
  expect(missingRun.response.status).toBe(404);
  expect(missingRun.json.ok).toBe(false);
});
