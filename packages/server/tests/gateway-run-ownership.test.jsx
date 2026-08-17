/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { Gateway } from "../src/gateway.js";

function workflowAt(dbPath) {
  const api = createSmithers({ out: z.object({ ok: z.boolean() }) }, { dbPath });
  return api.smithers(() => (
    <api.Workflow name="owned">
      <api.Task id="done" output={api.outputs.out}>
        {{ ok: true }}
      </api.Task>
    </api.Workflow>
  ));
}

function portOf(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

async function rpc(port, token, method, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function api(port, token, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}

describe("Gateway run ownership isolation", () => {
  let gateway;
  let dbPath;

  afterEach(async () => {
    await gateway?.close();
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  test("owned runs are listed, read, and controlled only by their exact authenticated pair", async () => {
    dbPath = join(tmpdir(), `smithers-owner-${crypto.randomUUID()}.db`);
    const workflow = workflowAt(dbPath);
    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: {
          alice: { role: "operator", scopes: ["run:read", "run:write"], userId: "alice", appId: "arb" },
          bob: { role: "operator", scopes: ["run:read", "run:write"], userId: "bob", appId: "arb" },
          "alice-other": {
            role: "operator",
            scopes: ["run:read", "run:write"],
            userId: "alice",
            appId: "other",
          },
          admin: { role: "admin", scopes: ["*"] },
        },
      },
    });
    gateway.register("owned", workflow);
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = portOf(server);

    const launched = await rpc(port, "alice", "launchRun", { workflow: "owned", input: {} });
    expect(launched.body.ok).toBe(true);
    expect(launched.body.payload.ownership).toEqual({ owner: "alice", app: "arb" });
    const runId = launched.body.payload.runId;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await rpc(port, "alice", "getRun", { runId })).body.ok) break;
      await Bun.sleep(10);
    }
    const aliceGet = await rpc(port, "alice", "getRun", { runId });
    expect(aliceGet.body.ok).toBe(true);
    expect(aliceGet.body.payload.ownership).toEqual({ owner: "alice", app: "arb" });

    const aliceList = await rpc(port, "alice", "listRuns", { filter: { includeSystem: true } });
    expect(aliceList.body.payload.map((run) => run.runId)).toContain(runId);
    for (const token of ["bob", "alice-other"]) {
      const list = await rpc(port, token, "listRuns", { filter: { includeSystem: true } });
      expect(list.body.payload.map((run) => run.runId)).not.toContain(runId);
      const get = await rpc(port, token, "getRun", { runId });
      expect(get.status).toBe(404);
      expect(get.body.error.code).toBe("RunNotFound");
      const cancel = await rpc(port, token, "cancelRun", { runId });
      expect(cancel.status).toBe(404);
      expect(cancel.body.error.code).toBe("RunNotFound");
      const events = await api(port, token, `/v1/api/runs/${runId}/events`);
      expect(events.status).toBe(404);
      expect(events.body.error.code).toBe("RunNotFound");
    }
    const duplicate = await rpc(port, "bob", "launchRun", { workflow: "owned", runId, input: {} });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONFLICT");
    const adminList = await rpc(port, "admin", "listRuns", {
      filter: { owner: "alice", app: "arb", includeSystem: true },
    });
    expect(adminList.body.payload.map((run) => run.runId)).toContain(runId);

    const adapter = gateway.adapterForWorkflow(workflow);
    expect(await adapter.getRun(runId)).toMatchObject({ owner: "alice", app: "arb" });
  });

  // #785 class: the app header is the second half of the tenant key, so an
  // operator who explicitly enumerated three trusted headers must not have a
  // fourth one silently start being honored by their (unchanged) proxy.
  test("trusted-proxy mode honors the app header only when it is explicitly allow-listed", async () => {
    dbPath = join(tmpdir(), `smithers-owner-proxy-${crypto.randomUUID()}.db`);
    const workflow = workflowAt(dbPath);

    const listWith = async (runId, trustedHeaders) => {
      const local = new Gateway({
        auth: {
          mode: "trusted-proxy",
          trustedProxies: ["127.0.0.1"],
          ...(trustedHeaders ? { trustedHeaders } : {}),
        },
      });
      local.register("owned", workflow);
      const adapter = local.adapterForWorkflow(workflow);
      await adapter.insertRun({
        runId,
        workflowName: "owned",
        status: "running",
        createdAtMs: 1,
        owner: "alice",
        app: "arb",
      });
      const server = await local.listen({ port: 0, host: "127.0.0.1" });
      try {
        const response = await fetch(`http://127.0.0.1:${portOf(server)}/v1/rpc/listRuns`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-user-id": "alice",
            "x-user-scopes": "run:read",
            "x-user-role": "operator",
            "x-app-id": "arb",
          },
          body: JSON.stringify({ filter: { includeSystem: true } }),
        });
        const body = await response.json();
        return body.payload.map((run) => run.runId);
      } finally {
        await local.close();
      }
    };

    // Omitted trustedHeaders => every default applies, including the app header.
    expect(await listWith("proxy-default", undefined)).toContain("proxy-default");
    // Explicit three-entry allow-list => x-app-id is ignored, the identity is
    // missing its app half, and the caller falls back to unowned runs only.
    expect(await listWith("proxy-three", ["x-user-id", "x-user-scopes", "x-user-role"])).not.toContain("proxy-three");
    // Explicit fourth entry => honored again, under the operator's own name.
    expect(await listWith("proxy-four", ["x-user-id", "x-user-scopes", "x-user-role", "x-app-id"])).toContain(
      "proxy-four",
    );
  });

  test("the ownership cache stays bounded without evicting a run the gateway is driving", () => {
    const local = new Gateway({});
    local.activeRuns.set("live-run", {});
    local.rememberRunOwnership({ runId: "live-run", owner: "alice", app: "arb" });
    for (let index = 0; index < 12_000; index += 1) {
      local.rememberRunOwnership({ runId: `cold-${index}`, owner: "alice", app: "arb" });
    }
    expect(local.runOwnershipById.size).toBeLessThanOrEqual(10_000);
    // The oldest entry, but live: eviction must walk past it.
    expect(local.runOwnershipById.get("live-run")).toEqual({ owner: "alice", app: "arb" });
    // The newest cold entries are the ones that survived.
    expect(local.runOwnershipById.has("cold-11999")).toBe(true);
    expect(local.runOwnershipById.has("cold-0")).toBe(false);
  });

  test("unowned legacy rows and an auth identity without app keep the single-tenant behavior", async () => {
    dbPath = join(tmpdir(), `smithers-owner-legacy-${crypto.randomUUID()}.db`);
    const workflow = workflowAt(dbPath);
    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: {
          legacy: { role: "operator", scopes: ["run:read", "run:write"], userId: "legacy-user" },
        },
      },
    });
    gateway.register("owned", workflow);
    const adapter = gateway.adapterForWorkflow(workflow);
    await adapter.insertRun({ runId: "legacy-run", workflowName: "owned", status: "running", createdAtMs: 1 });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = portOf(server);

    const listed = await rpc(port, "legacy", "listRuns", { filter: { includeSystem: true } });
    expect(listed.body.payload.map((run) => run.runId)).toContain("legacy-run");
    expect((await rpc(port, "legacy", "getRun", { runId: "legacy-run" })).body.ok).toBe(true);
    expect((await rpc(port, "legacy", "cancelRun", { runId: "legacy-run" })).body.ok).toBe(true);
  });
});
