import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SmithersDb } from "@smthrs/db/adapter";
import { createSmithersPostgres } from "../src/create.js";
import { withTempPostgresDatabase } from "./migrateStoreKit.js";
import {
  CHECKPOINT,
  CHECKPOINT_CODEC,
  MARKERS,
  NODE_ID,
  OUTPUT_VALUE,
} from "./fixtures/agentCheckpointRestartWorkflow.js";

setDefaultTimeout(180_000);

const PG_URL = process.env.SMITHERS_TEST_PG_URL;
const pgTest = PG_URL ? test : test.skip;
const CHILD = resolve(import.meta.dir, "fixtures/agentCheckpointRestartChild.js");
const RUN_ID = "run-postgres-agent-checkpoint-restart";
const TIMEOUT_MS = 60_000;
const children = new Set();
const markerDirs = new Set();

function killGroup(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

afterEach(() => {
  for (const child of children) killGroup(child);
  children.clear();
  for (const dir of markerDirs) rmSync(dir, { recursive: true, force: true });
  markerDirs.clear();
});

function spawnEngine(connectionString, mode, markerDir) {
  const readyPath = join(markerDir, `${mode}-process-ready`);
  const child = spawn(process.execPath, ["run", CHILD, connectionString, RUN_ID, mode, markerDir, "60000", readyPath], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  return { child, readyPath, output: () => ({ stdout, stderr }) };
}

async function waitFor(check, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForExit(handle) {
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return waitFor(
    () =>
      child.exitCode !== null || child.signalCode !== null
        ? { code: child.exitCode, signal: child.signalCode }
        : undefined,
    "child exit",
  ).catch((error) => {
    const output = handle.output();
    throw new Error(`${error.message}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCalls(markerDir) {
  const path = join(markerDir, MARKERS.calls);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

pgTest("fresh process force-resumes an exact generic-agent checkpoint committed before SIGKILL", async () => {
  await withTempPostgresDatabase("smithers_agent_checkpoint_restart", async (connectionString) => {
    const markerDir = mkdtempSync(join(tmpdir(), "smithers-agent-checkpoint-pg-"));
    markerDirs.add(markerDir);

    const initial = spawnEngine(connectionString, "initial", markerDir);
    await waitFor(() => existsSync(initial.readyPath), "initial process readiness");
    await waitFor(
      () =>
        existsSync(join(markerDir, MARKERS.retryReady)) ||
        initial.child.exitCode !== null ||
        initial.child.signalCode !== null,
      "retry receiving the checkpoint",
    );
    if (initial.child.exitCode !== null || initial.child.signalCode !== null) {
      throw new Error(`initial process exited before cutpoint: ${JSON.stringify(initial.output())}`);
    }

    const expectedReceived = { checkpointMode: "resume", resumeCheckpoint: CHECKPOINT };
    expect(readJson(join(markerDir, MARKERS.initialReceived))).toEqual(expectedReceived);

    let committedHash;
    const verifier = await createSmithersPostgres(
      { result: z.object({ value: z.number() }) },
      { provider: "postgres", connectionString },
    );
    try {
      const adapter = new SmithersDb(verifier.db);
      const refs = await waitFor(async () => {
        const rows = await adapter.listAgentCheckpointRefs(RUN_ID, { nodeId: NODE_ID });
        return rows.length === 1 ? rows : undefined;
      }, "independently committed PostgreSQL checkpoint ref");
      expect(refs[0]).toMatchObject({
        attempt: 1,
        sequence: 0,
        codec: CHECKPOINT_CODEC,
        version: 1,
        purpose: "turn",
      });
      committedHash = refs[0].contentHash;
      const content = await adapter.getAgentCheckpoint(refs[0].contentHash);
      expect(JSON.parse(content.checkpointJson)).toEqual(CHECKPOINT);
      expect((await adapter.getRun(RUN_ID))?.status).toBe("running");
      const attempts = await adapter.listAttempts(RUN_ID, NODE_ID, 0);
      expect(attempts.map((attempt) => attempt.state).sort()).toEqual(["failed", "in-progress"]);
      const active = attempts.find((attempt) => attempt.state === "in-progress");
      expect(JSON.parse(active.metaJson).resumedFromCheckpoint).toMatchObject({
        contentHash: refs[0].contentHash,
        codec: CHECKPOINT_CODEC,
        version: 1,
        mode: "resume",
      });
      const beforeKillOutput = await verifier.db.connection.query({
        text: 'SELECT count(*)::int AS count FROM "result" WHERE run_id = $1',
        values: [RUN_ID],
      });
      expect(beforeKillOutput.rows[0].count).toBe(0);
    } finally {
      await verifier.close();
    }

    killGroup(initial.child);
    const killed = await waitForExit(initial);
    expect(killed.signal).toBe("SIGKILL");

    const resumed = spawnEngine(connectionString, "resume", markerDir);
    await waitFor(() => existsSync(resumed.readyPath), "resume process readiness");
    const resumedExit = await waitForExit(resumed);
    expect(resumedExit).toEqual({ code: 0, signal: null });
    expect(resumed.output().stdout).toContain("RESULT_STATUS=finished");
    expect(readJson(join(markerDir, MARKERS.resumedReceived))).toEqual(expectedReceived);
    expect(readCalls(markerDir)).toEqual(["initial:fresh", "initial:resume", "resume:resume"]);

    const finalVerifier = await createSmithersPostgres(
      { result: z.object({ value: z.number() }) },
      { provider: "postgres", connectionString },
    );
    try {
      const adapter = new SmithersDb(finalVerifier.db);
      expect((await adapter.getRun(RUN_ID))?.status).toBe("finished");
      const finalRefs = await adapter.listAgentCheckpointRefs(RUN_ID, { nodeId: NODE_ID });
      expect(finalRefs).toHaveLength(1);
      expect(finalRefs[0].contentHash).toBe(committedHash);
      expect(JSON.parse((await adapter.getAgentCheckpoint(committedHash)).checkpointJson)).toEqual(CHECKPOINT);
      const rows = await finalVerifier.db.connection.query({
        text: 'SELECT run_id, node_id, iteration, value FROM "result" WHERE run_id = $1',
        values: [RUN_ID],
      });
      expect(rows.rows).toEqual([
        expect.objectContaining({ run_id: RUN_ID, node_id: NODE_ID, iteration: 0, value: OUTPUT_VALUE }),
      ]);
    } finally {
      await finalVerifier.close();
    }
  });
});
