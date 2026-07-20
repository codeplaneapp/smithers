/**
 * Concurrent RPC tests against a single resource. Verifies that two
 * getNodeOutput requests on the same run/node interleave safely, and that a
 * jumpToFrame interleaved with getNodeOutput does not corrupt either result.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React from "react";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";

function makeDbPath(name: string) {
  return join(
    tmpdir(),
    `smithers-concurrent-rpc-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function createConnectionContext() {
  return {
    connectionId: "test-connection",
    transport: "test",
    authenticated: true,
    sessionToken: "test-session",
    role: "operator",
    scopes: ["*"],
    userId: "user:test",
    subscribedRuns: new Set<string>(),
    heartbeatTimer: null,
  };
}

async function request(
  gateway: Gateway,
  connection: ReturnType<typeof createConnectionContext>,
  method: string,
  params?: Record<string, unknown>,
) {
  return (gateway as any).routeRequest(connection, {
    type: "req",
    id: `${method}-${Math.random().toString(36).slice(2)}`,
    method,
    params,
  });
}

async function waitForRunStatus(
  gateway: Gateway,
  connection: ReturnType<typeof createConnectionContext>,
  runId: string,
  statuses: string[],
  timeoutMs = 10_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await request(gateway, connection, "runs.get", { runId });
    if (response.ok && statuses.includes(String(response.payload.status))) {
      return response.payload;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${statuses.join(", ")}`);
}

describe("concurrent gateway RPC on the same resource", () => {
  const dbPaths: string[] = [];
  let gateway: Gateway | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
      gateway = undefined;
    }
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
  });

  test("two parallel getNodeOutput calls for the same run/node both succeed identically", async () => {
    const dbPath = makeDbPath("parallel-getNodeOutput");
    dbPaths.push(dbPath);

    const api = createSmithers(
      { result: z.object({ value: z.number() }) },
      { dbPath },
    );
    const workflow = api.smithers((ctx) =>
      React.createElement(
        api.Workflow,
        { name: "concurrent-getNodeOutput" },
        React.createElement(
          api.Task,
          { id: "task:main:0", output: api.outputs.result },
          { value: Number(ctx.input.value ?? 42) },
        ),
      ),
    );

    gateway = new Gateway();
    gateway.register("flow", workflow);

    const connection = createConnectionContext();
    const created = await request(gateway, connection, "runs.create", {
      workflow: "flow",
      input: { value: 42 },
    });
    expect(created.ok).toBe(true);
    const runId = String(created.payload.runId);
    await waitForRunStatus(gateway, connection, runId, ["finished"]);

    const [first, second] = await Promise.all([
      request(gateway, connection, "getNodeOutput", {
        runId,
        nodeId: "task:main:0",
        iteration: 0,
      }),
      request(gateway, connection, "getNodeOutput", {
        runId,
        nodeId: "task:main:0",
        iteration: 0,
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.payload.status).toBe("produced");
    expect(second.payload.status).toBe("produced");
    expect(first.payload.row).toEqual(second.payload.row);
    expect(first.payload.row).toEqual({ value: 42 });
  }, 20_000);

  test("jumpToFrame interleaved with getNodeOutput leaves both responses well-formed", async () => {
    const dbPath = makeDbPath("interleaved-jump");
    dbPaths.push(dbPath);

    const api = createSmithers(
      { result: z.object({ value: z.number() }) },
      { dbPath },
    );
    const workflow = api.smithers((ctx) =>
      React.createElement(
        api.Workflow,
        { name: "concurrent-jump" },
        React.createElement(
          api.Task,
          { id: "task:main:0", output: api.outputs.result },
          { value: Number(ctx.input.value ?? 1) },
        ),
      ),
    );

    gateway = new Gateway();
    gateway.register("flow", workflow);

    const connection = createConnectionContext();
    const created = await request(gateway, connection, "runs.create", {
      workflow: "flow",
      input: { value: 7 },
    });
    expect(created.ok).toBe(true);
    const runId = String(created.payload.runId);
    await waitForRunStatus(gateway, connection, runId, ["finished"]);

    // Issue both at once. We don't assert jumpToFrame succeeds (it may not be
    // permitted on a finished run); we only assert that running them together
    // does not corrupt the getNodeOutput response shape.
    const [jump, output] = await Promise.all([
      request(gateway, connection, "jumpToFrame", {
        runId,
        frameNo: 0,
      }),
      request(gateway, connection, "getNodeOutput", {
        runId,
        nodeId: "task:main:0",
        iteration: 0,
      }),
    ]);

    // jump may succeed or return a structured error — both are valid frames.
    expect(jump.type).toBe("res");
    expect(typeof jump.id).toBe("string");
    expect(output.ok).toBe(true);
    expect(output.payload.status).toBe("produced");
    expect(output.payload.row).toEqual({ value: 7 });
  }, 20_000);
});
