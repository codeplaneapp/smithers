/** @jsxImportSource smithers-orchestrator */
// The Electric write endpoint (§5.5): writes flow through the gateway RPC path,
// never through shapes. These tests prove the endpoint runs the real RPC,
// enforces scope, returns a null txid rather than a fabricated one (the prior
// out-of-band BEGIN/COMMIT raced the storage semaphore), and does NOT take a
// global DB lock — a concurrent RPC interleaves cleanly while a write runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Gateway server did not expose a port");
  return addr.port;
}

function makeDbPath(name) {
  return join(tmpdir(), `smithers-electric-write-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function createValueWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers(
    { outputA: z.object({ value: z.number() }) },
    { dbPath },
  );
  return smithers((ctx) => (
    <Workflow name="electric-write">
      <Task id="task1" output={outputs.outputA}>
        {{ value: Number(ctx.input.value ?? 1) }}
      </Task>
    </Workflow>
  ));
}

async function electricWrite(port, token, body) {
  return fetch(`http://127.0.0.1:${port}/v1/electric/write`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function postRpc(port, method, token, body) {
  return fetch(`http://127.0.0.1:${port}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("Gateway Electric write endpoint", () => {
  let gateway;
  let server;
  let dbPaths = [];

  beforeEach(() => {
    gateway = undefined;
    server = undefined;
    dbPaths = [];
  });

  afterEach(async () => {
    if (gateway) await gateway.close();
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
  });

  function bootGateway(dbPath) {
    const g = new Gateway({
      auth: {
        mode: "token",
        tokens: {
          "writer-token": { role: "operator", scopes: ["run:read", "run:write"], userId: "user:w" },
          "reader-token": { role: "viewer", scopes: ["run:read"], userId: "user:r" },
        },
      },
    });
    g.register("basic", createValueWorkflow(dbPath));
    return g;
  }

  test("runs the RPC, returns a null txid (no fabricated post-hoc txid), and launches the run", async () => {
    const dbPath = makeDbPath("launch");
    dbPaths.push(dbPath);
    gateway = bootGateway(dbPath);
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const response = await electricWrite(port, "writer-token", { method: "launchRun", params: { workflow: "basic", input: { value: 9 } } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    // The endpoint must NOT return a fabricated txid that would hang awaitTxId.
    expect(body.txid).toBeNull();
    const runId = String(body.payload.runId);
    expect(runId.length).toBeGreaterThan(0);

    // The run really launched through the normal engine path.
    let launched = false;
    for (let attempt = 0; attempt < 60 && !launched; attempt += 1) {
      const run = await postRpc(port, "getRun", "writer-token", { runId });
      if (run.status === 200) {
        const json = await run.json();
        if (json.ok && json.payload?.runId === runId) launched = true;
      }
      if (!launched) await sleep(25);
    }
    expect(launched).toBe(true);
  }, 20_000);

  test("enforces the gateway scope model: a run:read-only token cannot launch", async () => {
    const dbPath = makeDbPath("scope");
    dbPaths.push(dbPath);
    gateway = bootGateway(dbPath);
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const response = await electricWrite(port, "reader-token", { method: "launchRun", params: { workflow: "basic", input: {} } });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.requiredScope).toBe("run:write");
  });

  test("does not take a global DB lock: a concurrent RPC interleaves cleanly with a write", async () => {
    const dbPath = makeDbPath("concurrent");
    dbPaths.push(dbPath);
    gateway = bootGateway(dbPath);
    server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    // Fire an Electric write and an independent read RPC at the same time. If the
    // endpoint held an out-of-band transaction on the shared connection, the
    // concurrent listRuns could block or observe a half-open transaction; both
    // must return well-formed responses.
    const [write, list] = await Promise.all([
      electricWrite(port, "writer-token", { method: "launchRun", params: { workflow: "basic", input: { value: 1 } } }),
      postRpc(port, "listRuns", "writer-token", {}),
    ]);
    expect(write.status).toBe(200);
    expect((await write.json()).ok).toBe(true);
    expect(list.status).toBe(200);
    expect((await list.json()).ok).toBe(true);
  }, 20_000);
});
