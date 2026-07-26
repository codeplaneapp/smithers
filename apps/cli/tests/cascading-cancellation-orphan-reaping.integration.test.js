import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../../../packages/db/src/adapter.js";
import { ensureSmithersTables } from "../../../packages/db/src/ensure.js";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const TIMEOUT_MS = 120_000;
const processes = new Set();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(50);
  return predicate();
}

async function spawnDetachedOwner(pidFile) {
  const launcher = spawn(
    process.execPath,
    [
      "-e",
      `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const owner = spawn(process.execPath, ["-e", ${JSON.stringify(`
            const { spawn } = require("node:child_process");
            const { writeFileSync } = require("node:fs");
            const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
            writeFileSync(process.env.PIDS, process.pid + ":" + agent.pid);
            setInterval(() => {}, 1000);
        `)}], { detached: true, stdio: "ignore", env: process.env });
        owner.unref();
    `,
    ],
    { stdio: "ignore", env: { ...process.env, PIDS: pidFile } },
  );
  await new Promise((resolve) => launcher.once("exit", resolve));
  expect(await waitUntil(() => existsSync(pidFile))).toBe(true);
  const [ownerPid, agentPid] = readFileSync(pidFile, "utf8").split(":").map(Number);
  processes.add(ownerPid);
  processes.add(agentPid);
  return { ownerPid, agentPid };
}

afterEach(() => {
  for (const pid of processes) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  processes.clear();
});

async function insertRun(adapter, runId, overrides = {}) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "real-child-workflow",
    workflowPath: "child-workflow.tsx",
    status: "running",
    createdAtMs: now - 180_000,
    startedAtMs: now - 179_000,
    finishedAtMs: null,
    heartbeatAtMs: now - 150_000,
    ...overrides,
  });
}

describe.skipIf(process.platform === "win32")("cascading cancellation and orphan reaping integration", () => {
  test(
    "public cancel converges a nested mixed-state lineage and reaps every detached process tree",
    async () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      const sqlite = new Database(repo.path("smithers.db"));
      const db = drizzle(sqlite);
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      try {
        const childTree = await spawnDetachedOwner(repo.path("child.pids"));
        const grandchildTree = await spawnDetachedOwner(repo.path("grandchild.pids"));
        await insertRun(adapter, "parent");
        await insertRun(adapter, "child-running", {
          parentRunId: "parent",
          runtimeOwnerId: `pid:${childTree.ownerPid}:detached-child`,
        });
        await insertRun(adapter, "grandchild-waiting", {
          parentRunId: "child-running",
          status: "waiting-event",
          heartbeatAtMs: null,
          runtimeOwnerId: `pid:${grandchildTree.ownerPid}:detached-grandchild`,
        });
        await insertRun(adapter, "grandchild-paused", {
          parentRunId: "child-running",
          status: "paused",
          heartbeatAtMs: null,
          runtimeOwnerId: null,
        });

        const first = runSmithers(["cancel", "parent"], { cwd: repo.dir, format: "json", timeoutMs: TIMEOUT_MS });
        expect(first.exitCode).toBe(2);
        expect(first.json?.descendants?.discovered).toBe(3);
        expect(new Set(first.json?.terminatedOwners?.map((row) => row.runId))).toEqual(
          new Set(["child-running", "grandchild-waiting"]),
        );

        for (const runId of ["parent", "child-running", "grandchild-waiting", "grandchild-paused"]) {
          const run = await adapter.getRun(runId);
          expect(run.status).toBe("cancelled");
          expect(run.runtimeOwnerId).toBeNull();
        }
        for (const pid of [childTree.ownerPid, childTree.agentPid, grandchildTree.ownerPid, grandchildTree.agentPid]) {
          expect(await waitUntil(() => !alive(pid))).toBe(true);
        }

        const second = runSmithers(["cancel", "parent"], { cwd: repo.dir, format: "json", timeoutMs: TIMEOUT_MS });
        expect(second.exitCode).toBe(4);
        expect(second.json?.code).toBe("RUN_NOT_ACTIVE");
      } finally {
        sqlite.close();
      }
    },
    TIMEOUT_MS,
  );
});
