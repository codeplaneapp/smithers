import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { z } from "zod";
import { closeTrackedSmithers, createTrackedSmithers as createSmithers } from "./fixtures/tracked-smithers.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { Gateway } from "../src/gateway.js";

afterAll(closeTrackedSmithers);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function portOf(server: import("node:http").Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not expose a port");
  return address.port;
}

async function fixture() {
  const dbPath = join(tmpdir(), `smithers-oneshot-monitor-api-${crypto.randomUUID()}.db`);
  const api = createSmithers({ result: z.object({ ok: z.boolean() }) }, { dbPath });
  const workflow = api.smithers(() =>
    React.createElement(
      api.Workflow,
      { name: "oneshot" },
      React.createElement(api.Task, { id: "implement", output: api.outputs.result }, { ok: true }),
    ),
  );
  const adapter = new SmithersDb(api.db);
  await adapter.insertRun({
    runId: "oneshot-live",
    workflowName: "oneshot",
    status: "running",
    createdAtMs: Date.now(),
  });
  const calls: Array<{ action: string; runId: string; message?: string }> = [];
  const gateway = new Gateway({
    auth: {
      mode: "token",
      tokens: {
        writer: { role: "operator", scopes: ["run:read", "run:write"] },
        reader: { role: "viewer", scopes: ["run:read"] },
      },
    },
    oneshotMonitor: {
      attach: async ({ runId }) => {
        calls.push({ action: "attach", runId });
        return { runId, status: "attached" };
      },
      steer: async ({ runId, message }) => {
        calls.push({ action: "steer", runId, message });
        return { runId, status: "queued", messageId: "message-1" };
      },
      restart: async ({ runId }) => {
        calls.push({ action: "restart", runId });
        return { runId, status: "launched", restartedAsRunId: "oneshot-fresh" };
      },
    },
  });
  gateway.register("oneshot", workflow);
  const server = await gateway.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    await gateway.close();
    api.db.$client?.close?.();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });
  return { base: `http://127.0.0.1:${portOf(server)}`, calls };
}

async function post(base: string, path: string, body: unknown, token = "writer") {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() };
}

describe("Gateway oneshot monitor HTTP controls", () => {
  test("authenticates and transports attach, steer, and restart to the CLI host", async () => {
    const { base, calls } = await fixture();
    const prefix = "/v1/api/runs/oneshot-live/oneshot-monitor";
    const attached = await post(base, `${prefix}/attach`, {});
    const steered = await post(base, `${prefix}/steer`, { message: "Run the focused test first" });
    const restarted = await post(base, `${prefix}/restart`, {});
    expect(attached.response.status).toBe(200);
    expect(steered.json.data).toMatchObject({ status: "queued", messageId: "message-1" });
    expect(restarted.json.data).toMatchObject({ status: "launched", restartedAsRunId: "oneshot-fresh" });
    expect(calls).toEqual([
      { action: "attach", runId: "oneshot-live" },
      { action: "steer", runId: "oneshot-live", message: "Run the focused test first" },
      { action: "restart", runId: "oneshot-live" },
    ]);
  });

  test("requires run:write and reports missing messages honestly", async () => {
    const { base, calls } = await fixture();
    const path = "/v1/api/runs/oneshot-live/oneshot-monitor/steer";
    const forbidden = await post(base, path, { message: "hello" }, "reader");
    const invalid = await post(base, path, {});
    expect(forbidden.response.status).toBe(403);
    expect(invalid.response.status).toBe(400);
    expect(invalid.json.error.message).toContain("message");
    expect(calls).toEqual([]);
  });
});
