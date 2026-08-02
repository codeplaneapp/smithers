import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { Gateway } from "../src/gateway.js";

const connection = {
  connectionId: "readiness-test",
  transport: "test" as const,
  authenticated: true,
  sessionToken: "test",
  role: "operator" as const,
  scopes: ["*"],
  userId: "user:test",
  subscribedRuns: new Set<string>(),
  heartbeatTimer: null,
};

describe("Gateway workflow readiness", () => {
  let gateway: Gateway | undefined;
  let dbPath = "";

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    if (dbPath) rmSync(dbPath, { force: true });
  });

  test("health exposes compatible defaults and host progress on HTTP and RPC", async () => {
    let loaded = 0;
    gateway = new Gateway({ workflowRegistryStatus: () => ({ workflowsLoaded: loaded, workflowsTotal: 2 }) });
    const server = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const initial = await (await fetch(`${baseUrl}/health`)).json();
    expect(initial).toMatchObject({ ok: true, workflowsLoaded: 0, workflowsTotal: 2 });
    loaded = 2;
    const complete = await (await fetch(`${baseUrl}/health`)).json();
    expect(complete).toMatchObject({ ok: true, workflowsLoaded: 2, workflowsTotal: 2 });
    const rpc = await (
      await fetch(`${baseUrl}/v1/rpc/health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "health", method: "health", params: {} }),
      })
    ).json();
    expect(rpc.payload).toMatchObject({ workflowsLoaded: 2, workflowsTotal: 2 });
    await gateway.close();
    gateway = undefined;

    const defaults = new Gateway();
    gateway = defaults;
    const defaultServer = await defaults.listen({ host: "127.0.0.1", port: 0 });
    const defaultPort = (defaultServer.address() as { port: number }).port;
    expect(await (await fetch(`http://127.0.0.1:${defaultPort}/health`)).json()).toMatchObject({
      workflowsLoaded: 0,
      workflowsTotal: 0,
    });
  });

  test("launch waits for a deduplicated workflow registry refresh", async () => {
    dbPath = join(tmpdir(), `smithers-readiness-${Date.now()}.db`);
    const api = createSmithers({ result: z.object({ value: z.number() }) }, { dbPath });
    const workflow = api.smithers((ctx) =>
      React.createElement(
        api.Workflow,
        { name: "delayed" },
        React.createElement(
          api.Task,
          { id: "task:main:0", output: api.outputs.result },
          { value: Number(ctx.input.value ?? 1) },
        ),
      ),
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshes = 0;
    gateway = new Gateway({
      workflowRegistryRefresh: async (key) => {
        refreshes += 1;
        await blocked;
        gateway!.register(key, workflow);
      },
    });
    const first = gateway.routeRequest(connection, {
      type: "req",
      id: "one",
      method: "launchRun",
      params: { workflow: "delayed", input: { value: 7 } },
    });
    const second = gateway.routeRequest(connection, {
      type: "req",
      id: "two",
      method: "launchRun",
      params: { workflow: "delayed", input: { value: 8 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshes).toBe(1);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
  }, 20_000);

  test("a workflow registered after listen serves its declared UI mount", async () => {
    // The lazy registry loads workflow modules after listen(), so the mount
    // path a workflow declares with <UI path="…"> is unknowable until then.
    // Clients can only construct the conventional /workflows/<key> route, so
    // that route must both trigger the registration AND land on the real mount
    // — no gateway restart (#1362).
    const root = mkdtempSync(join(tmpdir(), "smithers-lazy-ui-mount-"));
    dbPath = join(root, "late.db");
    const api = createSmithers({}, { dbPath });
    const late = api.smithers(() => React.createElement(api.Workflow, { name: "late" }));
    mkdirSync(join(root, "workflows"), { recursive: true });
    mkdirSync(join(root, "ui"), { recursive: true });
    const entryFile = join(root, "workflows", "late.tsx");
    const uiEntry = join(root, "ui", "late-ui.tsx");
    writeFileSync(entryFile, "// entry\n", "utf8");
    writeFileSync(uiEntry, "// ui\n", "utf8");

    gateway = new Gateway({
      workflowRegistryRefresh: async (key: string) => {
        if (key === "late") {
          gateway!.register("late", late, { entryFile, ui: { entry: uiEntry, path: "/custom-mount" } });
        }
      },
    });
    const server = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as { port: number }).port;

    const redirect = await fetch(`http://127.0.0.1:${port}/workflows/late?runId=run-1`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/custom-mount?runId=run-1");
    expect(gateway.workflows.has("late")).toBe(true);
    const served = await fetch(`http://127.0.0.1:${port}/workflows/late?runId=run-1`);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("/custom-mount");

    // An unknown key still 404s rather than redirecting anywhere.
    expect((await fetch(`http://127.0.0.1:${port}/workflows/never`, { redirect: "manual" })).status).toBe(404);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test("aggregate workflow lists wait for registry readiness", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = false;
    gateway = new Gateway({
      workflowRegistryStatus: () => ({ workflowsLoaded: ready ? 1 : 0, workflowsTotal: 1 }),
      workflowRegistryReady: async () => {
        await blocked;
      },
    });
    dbPath = join(tmpdir(), `smithers-list-readiness-${Date.now()}.db`);
    const api = createSmithers({}, { dbPath });
    gateway.register(
      "delayed",
      api.smithers(() => React.createElement(api.Workflow, { name: "delayed" })),
    );
    const server = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as { port: number }).port;
    const list = fetch(`http://127.0.0.1:${port}/workflows`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let settled = false;
    void list.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    ready = true;
    release();
    expect((await (await list).json()).workflows).toHaveLength(1);
  }, 20_000);
});
