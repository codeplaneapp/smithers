import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { killProcess } from "../harness/killProcess.ts";
import {
  CHECKPOINT,
  CHECKPOINT_CODEC,
  CHECKPOINT_MARKERS,
  NODE_ID,
  OUTPUT_VALUE,
  buildGenericAgentCheckpointWorkflow,
  type GenericCheckpointMode,
} from "../harness/genericAgentCheckpointWorkflow.ts";

const RUN_ID = "run-case32-generic-checkpoint";
const BLOCK_MS = 60_000;
const TIMEOUT_MS = 60_000;
const POLL_MS = 25;
const RUNNER = fileURLToPath(new URL("../harness/genericAgentCheckpointChildRunner.ts", import.meta.url));

function asOutputTable(table: unknown): any {
  return table;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(POLL_MS);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function spawnEngine(dbPath: string, mode: GenericCheckpointMode, markerDir: string): ChildProcess {
  return spawn("bun", [RUNNER, dbPath, RUN_ID, mode, markerDir, String(BLOCK_MS), crypto.randomUUID()], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCalls(markerDir: string): string[] {
  const path = join(markerDir, CHECKPOINT_MARKERS.calls);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

describe("case32 generic-agent checkpoint fresh-process recovery", () => {
  const dbPaths: string[] = [];
  const markerDirs: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }
    }
    children.length = 0;
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    }
    dbPaths.length = 0;
    for (const markerDir of markerDirs) {
      rmSync(markerDir, { recursive: true, force: true });
    }
    markerDirs.length = 0;
  });

  test("SIGKILL after retry receives checkpoint, then force-resume delivers exact bytes", async () => {
    const dbPath = join(tmpdir(), `smithers-case32-${crypto.randomUUID()}.db`);
    const markerDir = mkdtempSync(join(tmpdir(), "smithers-case32-markers-"));
    dbPaths.push(dbPath);
    markerDirs.push(markerDir);

    const initial = spawnEngine(dbPath, "initial", markerDir);
    children.push(initial);
    expect(typeof initial.pid).toBe("number");
    let initialStderr = "";
    let initialExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    initial.stderr?.on("data", (chunk) => (initialStderr += String(chunk)));
    initial.once("exit", (code, signal) => (initialExit = { code, signal }));

    await waitFor(
      () => existsSync(join(markerDir, CHECKPOINT_MARKERS.retryReady)) || initialExit !== null,
      TIMEOUT_MS,
      "checkpoint retry readiness",
    );
    if (initialExit !== null) {
      throw new Error(`initial process exited before cutpoint: ${JSON.stringify(initialExit)}\n${initialStderr}`);
    }

    const expectedReceived = {
      checkpointMode: "resume",
      resumeCheckpoint: CHECKPOINT,
    };
    expect(readJson(join(markerDir, CHECKPOINT_MARKERS.initialReceived))).toEqual(expectedReceived);

    // Inspect from a separate SQLite handle while process A is blocked. The
    // checkpoint and its retry provenance must already be committed pre-kill.
    const preKillFixture = buildGenericAgentCheckpointWorkflow({
      dbPath,
      markerDir,
      mode: "resume",
    });
    ensureSmithersTables(preKillFixture.db);
    const preKillAdapter = new SmithersDb(preKillFixture.db);
    expect((await preKillAdapter.getRun(RUN_ID))?.status).toBe("running");
    const preKillRefs = await preKillAdapter.listAgentCheckpointRefs(RUN_ID, {
      nodeId: NODE_ID,
    });
    expect(preKillRefs).toHaveLength(1);
    expect(preKillRefs[0]).toMatchObject({
      attempt: 1,
      sequence: 0,
      codec: CHECKPOINT_CODEC,
      version: 1,
      purpose: "turn",
    });
    const content = await preKillAdapter.getAgentCheckpoint(String(preKillRefs[0].contentHash));
    expect(JSON.parse(String(content?.checkpointJson))).toEqual(CHECKPOINT);
    const preKillAttempts = await preKillAdapter.listAttempts(RUN_ID, NODE_ID, 0);
    expect(preKillAttempts.map((attempt) => attempt.state)).toEqual(["in-progress", "failed"]);
    const inProgressAttempt = preKillAttempts.find((attempt) => attempt.state === "in-progress");
    expect(JSON.parse(String(inProgressAttempt?.metaJson)).resumedFromCheckpoint).toMatchObject({
      contentHash: preKillRefs[0].contentHash,
      codec: CHECKPOINT_CODEC,
      version: 1,
      mode: "resume",
    });

    await killProcess({ pid: initial.pid as number });

    const resumed = spawnEngine(dbPath, "resume", markerDir);
    children.push(resumed);
    let resumedStdout = "";
    let resumedStderr = "";
    resumed.stdout?.on("data", (chunk) => (resumedStdout += String(chunk)));
    resumed.stderr?.on("data", (chunk) => (resumedStderr += String(chunk)));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`resume timed out\nstdout:\n${resumedStdout}\nstderr:\n${resumedStderr}`)),
        TIMEOUT_MS,
      );
      resumed.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    expect(exitCode).toBe(0);
    expect(resumedStdout).toContain("RESULT_STATUS=finished");
    expect(readJson(join(markerDir, CHECKPOINT_MARKERS.resumedReceived))).toEqual(expectedReceived);
    expect(readCalls(markerDir)).toEqual(["initial:fresh", "initial:resume", "resume:resume"]);

    const finalFixture = buildGenericAgentCheckpointWorkflow({
      dbPath,
      markerDir,
      mode: "resume",
    });
    ensureSmithersTables(finalFixture.db);
    const finalAdapter = new SmithersDb(finalFixture.db);
    expect((await finalAdapter.getRun(RUN_ID))?.status).toBe("finished");
    expect(await finalFixture.db.select().from(asOutputTable(finalFixture.tables.result))).toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        nodeId: NODE_ID,
        iteration: 0,
        value: OUTPUT_VALUE,
      }),
    ]);
  }, 180_000);
});
