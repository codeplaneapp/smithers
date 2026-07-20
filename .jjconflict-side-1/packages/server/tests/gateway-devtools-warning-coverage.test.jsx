/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Gateway } from "../src/gateway.js";

/**
 * Covers the gateway's DevTools serializer onWarning callbacks (getDevToolsSnapshot
 * and streamDevTools) by seeding a run whose frame tree is deeper than the
 * serializer's max depth, and the register-time rewind-audit recovery catch by
 * removing the audit table so recovery rejects but registration still succeeds.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

// A single task node whose PROP VALUE is nested past the serializer's default
// max depth (100), so serializing the props emits a MaxDepthExceeded warning.
function deepPropsXml(depth) {
  let deep = { v: 1 };
  for (let i = 0; i < depth; i += 1) deep = { v: deep };
  return canonicalizeXml({
    kind: "element",
    tag: "smithers:workflow",
    props: { name: "deep" },
    children: [
      { kind: "element", tag: "smithers:task", props: { id: "task::0", deep }, children: [] },
    ],
  });
}

function fakeConnection() {
  const sent = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send(data) { sent.push(JSON.parse(data)); } };
  return {
    connection: {
      transport: "ws", ws, authenticated: true, scopes: ["*"], seq: 0,
      role: "operator", userId: "user:test", tokenId: "tok", connectionId: "conn-warn",
    },
    sent,
  };
}

function reqFrame(method, params = {}) {
  return { type: "req", id: `${method}-1`, method, params };
}

const cleanups = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch {} }
});

function makeWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs, db } = createSmithers({ result: z.object({ value: z.number() }) }, { dbPath });
  const workflow = smithers(() => (
    <Workflow name="warn-wf">
      <Task id="task1" output={outputs.result}>{{ value: 1 }}</Task>
    </Workflow>
  ));
  return { workflow, db };
}

function makeDbPath(name) {
  const dbPath = join(tmpdir(), `smithers-warn-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  cleanups.push(() => { for (const s of ["", "-shm", "-wal"]) { try { rmSync(`${dbPath}${s}`, { force: true }); } catch {} } });
  return dbPath;
}

describe("gateway devtools serializer warnings and audit recovery", () => {
  test("a too-deep snapshot tree drives the serializer onWarning on both routes", async () => {
    const dbPath = makeDbPath("deep");
    const { workflow, db } = makeWorkflow(dbPath);
    const gateway = new Gateway({});
    cleanups.push(() => gateway.close());
    gateway.register("warn-wf", workflow);
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    getPort(server);

    const adapter = new SmithersDb(db);
    const runId = "deep-run";
    await adapter.insertRun({ runId, workflowName: "warn-wf", status: "finished", createdAtMs: Date.now() });
    await adapter.insertFrame({
      runId,
      frameNo: 0,
      createdAtMs: Date.now(),
      xmlJson: deepPropsXml(140),
      xmlHash: "deep-hash",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "deep",
    });

    // getDevToolsSnapshot: the serializer exceeds max depth and emits a warning,
    // which the gateway forwards through its onWarning callback.
    const snapConn = fakeConnection();
    const snapRes = await gateway.routeRequest(snapConn.connection, reqFrame("getDevToolsSnapshot", { runId }));
    expect(snapRes.ok).toBe(true);
    expect(snapRes.payload).toBeTruthy();

    // streamDevTools: the initial snapshot serialization emits the same warning
    // through the stream's onWarning callback.
    const streamConn = fakeConnection();
    const streamRes = await gateway.routeRequest(streamConn.connection, reqFrame("streamDevTools", { runId, fromSeq: 0 }));
    expect(streamRes.ok).toBe(true);
    await sleep(120);
    expect(streamConn.sent.some((e) => e.event === "devtools.event")).toBe(true);
  }, 20000);

  test("register swallows a rewind-audit recovery failure and still registers", async () => {
    const dbPath = makeDbPath("audit");
    const { workflow, db } = makeWorkflow(dbPath);
    // Remove the audit table so the register-time recovery query rejects; the
    // catch must swallow it so registration and the gateway still work.
    db.$client.run("DROP TABLE IF EXISTS _smithers_time_travel_audit");
    const gateway = new Gateway({});
    cleanups.push(() => gateway.close());
    expect(() => gateway.register("warn-wf", workflow)).not.toThrow();
    // Give the fire-and-forget recovery promise a tick to reject into its catch.
    await sleep(50);
    expect(gateway.workflows.has("warn-wf")).toBe(true);
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);
    const res = await fetch(`http://127.0.0.1:${port}/v1/rpc/listWorkflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
  }, 20000);
});
