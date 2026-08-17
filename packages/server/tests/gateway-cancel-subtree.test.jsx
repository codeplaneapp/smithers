/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { Gateway } from "../src/gateway.js";

/**
 * The public HTTP/RPC cancellation must drive the SAME recursive subtree
 * operation as `smithers cancel` (#971): a cancel of a root run reaches every
 * transitive child-workflow descendant, returns a complete result, and never
 * touches an unrelated run.
 */

function makeDbPath() {
  return join(tmpdir(), `smithers-gateway-cancel-subtree-${Date.now()}-${crypto.randomUUID()}.db`);
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeWorkflow(dbPath) {
  const api = createSmithers({ output: z.object({ value: z.number() }) }, { dbPath });
  const started = deferred();
  const release = deferred();
  const workflow = api.smithers(() => (
    <api.Workflow name="cancel-subtree">
      <api.Task id="task" output={api.outputs.output}>
        {async () => {
          started.resolve();
          await release.promise;
          return { value: 1 };
        }}
      </api.Task>
    </api.Workflow>
  ));
  return { workflow, started, release };
}

const STALE_HEARTBEAT_MS = 120_000;

/** Pids spawned by a test; reaped afterEach so a failure cannot leak them. */
const spawnedPids = [];
const tempDirs = [];

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

/**
 * Spawn a real ORPHANED detached keep-alive process — the shape of a parked
 * `smithers up -d` run owner whose launcher already exited.
 *
 * @returns {Promise<number>}
 */
async function spawnDetachedOwner() {
  const dir = mkdtempSync(join(tmpdir(), "gateway-cancel-owner-"));
  tempDirs.push(dir);
  const pidFile = join(dir, "owner.pid");
  const launcher = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const { writeFileSync } = require("node:fs");
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
       child.unref();
       writeFileSync(process.env.PID_FILE, String(child.pid));
       process.exit(0);`,
    ],
    { stdio: "ignore", env: { ...process.env, PID_FILE: pidFile } },
  );
  await new Promise((resolvePromise) => launcher.on("exit", resolvePromise));
  await waitFor(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  spawnedPids.push(pid);
  return pid;
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Gateway cancelRun cancels the whole run subtree", () => {
  let gateway;
  let dbPath;
  let releaseActiveRuns;

  afterEach(async () => {
    releaseActiveRuns?.();
    await gateway?.close();
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  test("reaches every descendant, reports them, and spares unrelated runs", async () => {
    dbPath = makeDbPath();
    const rootWorkflow = makeWorkflow(dbPath);
    releaseActiveRuns = () => rootWorkflow.release.resolve();
    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: { "operator-token": { role: "operator", scopes: ["*"], userId: "user:operator" } },
      },
      heartbeatMs: 1_000,
    });
    gateway.register("cancel-subtree", rootWorkflow.workflow);
    const adapter = gateway.adapterForWorkflow(rootWorkflow.workflow);
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await gateway.startRun(
      "cancel-subtree",
      {},
      { triggeredBy: "test", scopes: ["*"], role: "operator", tokenId: null },
      "subtree-root",
    );
    await rootWorkflow.started.promise;

    // A parked child in another process, plus a grandchild beneath it. Both
    // carry a stale heartbeat, so cancellation must flip them directly.
    const now = Date.now();
    await adapter.insertRun({
      runId: "subtree-child",
      parentRunId: "subtree-root",
      workflowName: "cancel-subtree",
      status: "waiting-approval",
      createdAtMs: now,
      heartbeatAtMs: now - STALE_HEARTBEAT_MS,
    });
    await adapter.insertRun({
      runId: "subtree-grandchild",
      parentRunId: "subtree-child",
      workflowName: "cancel-subtree",
      status: "running",
      createdAtMs: now,
      heartbeatAtMs: now - STALE_HEARTBEAT_MS,
    });
    await adapter.insertRun({
      runId: "unrelated-run",
      workflowName: "cancel-subtree",
      status: "waiting-event",
      createdAtMs: now,
      heartbeatAtMs: now - STALE_HEARTBEAT_MS,
    });

    const response = await fetch(`${baseUrl}/v1/rpc/cancelRun`, {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
        "x-request-id": "subtree-cancel-1",
      },
      body: JSON.stringify({ runId: "subtree-root" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.payload).toMatchObject({ runId: "subtree-root", won: true, status: "cancelled" });
    const descendants = Object.fromEntries(json.payload.descendants.map((row) => [row.runId, row]));
    expect(descendants["subtree-child"]).toMatchObject({ depth: 1, action: "cancelled" });
    expect(descendants["subtree-grandchild"]).toMatchObject({ depth: 2, action: "cancelled" });
    expect(descendants["unrelated-run"]).toBeUndefined();

    expect((await adapter.getRun("subtree-child")).status).toBe("cancelled");
    expect((await adapter.getRun("subtree-grandchild")).status).toBe("cancelled");
    // Descendants inherit the caller's durable attribution.
    expect((await adapter.getRun("subtree-child")).cancelRequestId).toBe("subtree-cancel-1");
    // ...and nothing outside the subtree is affected.
    expect((await adapter.getRun("unrelated-run")).status).toBe("waiting-event");
  });

  test("a terminal root with a live descendant still cancels it instead of 400ing", async () => {
    dbPath = makeDbPath();
    const rootWorkflow = makeWorkflow(dbPath);
    releaseActiveRuns = () => rootWorkflow.release.resolve();
    gateway = new Gateway({
      auth: {
        mode: "token",
        tokens: { "operator-token": { role: "operator", scopes: ["*"], userId: "user:operator" } },
      },
      heartbeatMs: 1_000,
    });
    gateway.register("cancel-subtree", rootWorkflow.workflow);
    const adapter = gateway.adapterForWorkflow(rootWorkflow.workflow);
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const now = Date.now();
    // A parent that crashed and was marked failed, whose child workflow is
    // still parked in a detached owner — the orphaned-subtree case.
    await adapter.insertRun({
      runId: "dead-root",
      workflowName: "cancel-subtree",
      status: "failed",
      createdAtMs: now,
      finishedAtMs: now,
    });
    await adapter.insertRun({
      runId: "orphan-child",
      parentRunId: "dead-root",
      workflowName: "cancel-subtree",
      status: "waiting-timer",
      createdAtMs: now,
      heartbeatAtMs: now - STALE_HEARTBEAT_MS,
    });
    await adapter.insertRun({
      runId: "fully-done-root",
      workflowName: "cancel-subtree",
      status: "finished",
      createdAtMs: now,
      finishedAtMs: now,
    });

    const response = await fetch(`${baseUrl}/v1/rpc/cancelRun`, {
      method: "POST",
      headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
      body: JSON.stringify({ runId: "dead-root" }),
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.payload.descendants).toContainEqual({ runId: "orphan-child", depth: 1, action: "cancelled" });
    expect((await adapter.getRun("orphan-child")).status).toBe("cancelled");
    // The failed root is not regressed to cancelled.
    expect((await adapter.getRun("dead-root")).status).toBe("failed");

    // A subtree with nothing left to cancel is still RUN_NOT_ACTIVE.
    const inert = await fetch(`${baseUrl}/v1/rpc/cancelRun`, {
      method: "POST",
      headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
      body: JSON.stringify({ runId: "fully-done-root" }),
    });
    const inertJson = await inert.json();
    expect(inertJson.ok).toBe(false);
    expect(inertJson.error?.code).toBe("RUN_NOT_ACTIVE");
  });

  test.skipIf(process.platform === "win32")(
    "terminates the REQUESTED run's own detached owner process tree",
    async () => {
      dbPath = makeDbPath();
      const rootWorkflow = makeWorkflow(dbPath);
      releaseActiveRuns = () => rootWorkflow.release.resolve();
      gateway = new Gateway({
        auth: {
          mode: "token",
          tokens: { "operator-token": { role: "operator", scopes: ["*"], userId: "user:operator" } },
        },
        heartbeatMs: 1_000,
      });
      gateway.register("cancel-subtree", rootWorkflow.workflow);
      const adapter = gateway.adapterForWorkflow(rootWorkflow.workflow);
      const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      // A run parked in a DETACHED owner: the terminal claim strips
      // runtime_owner_id, so the cascade can no longer see the pid. If the RPC
      // does not terminate it up front, the owner and its agents outlive the
      // cancelled run — exactly #972.
      const ownerPid = await spawnDetachedOwner();
      const now = Date.now();
      await adapter.insertRun({
        runId: "detached-root",
        workflowName: "cancel-subtree",
        status: "waiting-approval",
        createdAtMs: now,
        heartbeatAtMs: now - STALE_HEARTBEAT_MS,
        runtimeOwnerId: `pid:${ownerPid}:detached-owner`,
      });

      const response = await fetch(`${baseUrl}/v1/rpc/cancelRun`, {
        method: "POST",
        headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
        body: JSON.stringify({ runId: "detached-root" }),
      });
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.payload).toMatchObject({ runId: "detached-root", won: true });
      expect(json.payload.terminatedOwners).toContainEqual({ runId: "detached-root", pid: ownerPid });
      expect(await waitFor(() => !pidAlive(ownerPid))).toBe(true);
      expect((await adapter.getRun("detached-root")).status).toBe("cancelled");
    },
    20_000,
  );
});
