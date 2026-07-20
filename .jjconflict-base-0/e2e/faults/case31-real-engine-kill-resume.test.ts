import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { killProcess } from "../harness/killProcess.ts";
import {
  A_NODE_ID,
  A_VALUE,
  B_NODE_ID,
  B_VALUE,
  MARKERS,
  buildKillResumeWorkflow,
} from "../harness/killResumeWorkflow.ts";

/**
 * case31 — REAL engine kill-and-restart durability.
 *
 * Unlike case01-06, which simulate a crash by writing a stale heartbeat into a
 * hand-built :memory: table (corruptHeartbeat), this case kills a REAL engine
 * OS process with SIGKILL while it is actively executing a node, then resumes
 * the run from its last on-disk checkpoint in a fresh process. It verifies
 * smithers' #1 guarantee: a run survives SIGKILL of the engine and resumes
 * at-least-once external execution and journaled-at-most-once durable-row CAS.
 *
 * Mechanism:
 *   1. On-disk sqlite db (a real file in tmpdir, NOT :memory: — a fresh process
 *      must reopen it).
 *   2. The engine runs in a SEPARATE child process (spawn `bun
 *      engineChildRunner.ts`), so it owns a real, SIGKILL-able pid.
 *   3. Node A commits its output immediately; node B writes a `B.started`
 *      sidecar marker and then sleeps. The test polls for `B.started` and
 *      SIGKILLs the engine while B is in-flight (no fixed-sleep race).
 *   4. A fresh child resumes the same run (resume + force; force is required
 *      because the just-killed engine's heartbeat is not yet 30s-stale).
 *   5. Asserts the durability invariant from the committed db + a cross-process
 *      execution-counter file:
 *        - run reaches status "finished";
 *        - each committed node has EXACTLY ONE output row (no double-commit);
 *        - node A (completed pre-kill) is NOT re-executed on resume — it appears
 *          once in the external-effect counter;
 *        - node B (interrupted) does complete after resume.
 *
 * No agent CLI is used (compute Tasks only), so this runs on a clean CI box.
 */

const RUN_ID = "run-case31";
const POLL_INTERVAL_MS = 25;
const MARKER_TIMEOUT_MS = 60_000;
const RESUME_EXIT_TIMEOUT_MS = 60_000;
const B_SLEEP_MS = 60_000;

const RUNNER_SCRIPT = fileURLToPath(
  new URL("../harness/engineChildRunner.ts", import.meta.url),
);

// Returns `any` so the opaque output table is accepted by db.select().from()
// regardless of which drizzle-orm peer-instance resolved its SQLiteTable type.
function outputTable(table: unknown): any {
  return table;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out (${timeoutMs}ms) waiting for ${label}`);
}

function spawnEngine(
  dbPath: string,
  mode: "initial" | "resume",
  markerDir: string,
  counterFile: string,
  nonce = crypto.randomUUID(),
): ChildProcess {
  return spawn(
    "bun",
    [
      RUNNER_SCRIPT,
      dbPath,
      RUN_ID,
      mode,
      markerDir,
      counterFile,
      String(B_SLEEP_MS),
      nonce,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function readCounter(counterFile: string): string[] {
  if (!existsSync(counterFile)) return [];
  return readFileSync(counterFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("case31 real engine kill + resume durability", () => {
  const dbPaths: string[] = [];
  const markerDirs: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
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
    for (const dir of markerDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    markerDirs.length = 0;
  });

  test("SIGKILL mid-node then resume: at-least-once execution, journaled-at-most-once durable commit", async () => {
    const dbPath = join(
      tmpdir(),
      `smithers-case31-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    dbPaths.push(dbPath);
    const markerDir = mkdtempSync(join(tmpdir(), "smithers-case31-markers-"));
    markerDirs.push(markerDir);
    const counterFile = join(markerDir, "executions.log");

    // --- Phase 1: run the engine in a real child process until node B is
    // in-flight, then SIGKILL it for real. ---
    const child = spawnEngine(dbPath, "initial", markerDir, counterFile);
    children.push(child);
    expect(typeof child.pid).toBe("number");
    const enginePid = child.pid as number;

    let childStderr = "";
    child.stderr?.on("data", (chunk) => {
      childStderr += String(chunk);
    });
    // Surface an early child crash instead of silently waiting for a marker.
    let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    child.once("exit", (code, signal) => {
      earlyExit = { code, signal };
    });

    await waitFor(
      () =>
        existsSync(join(markerDir, MARKERS.bStarted)) || earlyExit !== null,
      MARKER_TIMEOUT_MS,
      "node B to start (B.started marker)",
    );
    if (earlyExit !== null) {
      throw new Error(
        `engine child exited before node B started (code=${
          (earlyExit as { code: number | null }).code
        }, signal=${
          (earlyExit as { signal: NodeJS.Signals | null }).signal
        }). stderr:\n${childStderr}`,
      );
    }

    // Node A must have committed and node B must NOT yet have completed:
    // we are killing while B is genuinely in-flight.
    expect(existsSync(join(markerDir, MARKERS.aDone))).toBe(true);
    expect(existsSync(join(markerDir, MARKERS.bDone))).toBe(false);

    // REAL kill: SIGKILL the actively-running engine pid via the harness.
    await killProcess({ pid: enginePid });
    expect(existsSync(join(markerDir, MARKERS.bDone))).toBe(false);

    // Sanity: exactly one execution of each so far (A once, B once, B not done).
    expect(readCounter(counterFile)).toEqual([A_NODE_ID, B_NODE_ID]);

    // --- Phase 2: resume in a FRESH engine process. ---
    const resumeChild = spawnEngine(dbPath, "resume", markerDir, counterFile);
    children.push(resumeChild);
    let resumeStdout = "";
    let resumeStderr = "";
    resumeChild.stdout?.on("data", (chunk) => {
      resumeStdout += String(chunk);
    });
    resumeChild.stderr?.on("data", (chunk) => {
      resumeStderr += String(chunk);
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `resume child did not exit within ${RESUME_EXIT_TIMEOUT_MS}ms. stdout:\n${resumeStdout}\nstderr:\n${resumeStderr}`,
          ),
        );
      }, RESUME_EXIT_TIMEOUT_MS);
      resumeChild.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exitCode).toBe(0);
    expect(resumeStdout).toContain("RESULT_STATUS=finished");

    // --- Phase 3: assert the durability invariant against the committed db. ---
    // Reopen the on-disk db in THIS process (a fresh handle) and inspect it.
    const { db, tables } = buildKillResumeWorkflow({
      dbPath,
      markerDir,
      counterFile,
      mode: "resume",
    });
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);

    const run = await adapter.getRun(RUN_ID);
    expect(run?.status).toBe("finished");

    // Each committed node has EXACTLY ONE output row — no double-commit from
    // re-execution after resume.
    const aRows = await db.select().from(outputTable(tables.a));
    expect(aRows).toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        nodeId: A_NODE_ID,
        iteration: 0,
        value: A_VALUE,
      }),
    ]);

    const bRows = await db.select().from(outputTable(tables.b));
    expect(bRows).toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        nodeId: B_NODE_ID,
        iteration: 0,
        value: B_VALUE,
      }),
    ]);

    // Durable idempotent completion: node A (committed before the kill) is NOT
    // re-executed on resume, so it appears once. Node B was interrupted
    // (no output committed before the kill) so it re-executes on resume and
    // appears twice — but still commits exactly one output row (asserted above).
    const counter = readCounter(counterFile);
    expect(counter.filter((id) => id === A_NODE_ID)).toEqual([A_NODE_ID]);
    expect(counter.filter((id) => id === B_NODE_ID)).toEqual([
      B_NODE_ID,
      B_NODE_ID,
    ]);
    expect(counter).toEqual([A_NODE_ID, B_NODE_ID, B_NODE_ID]);

    // Node B did complete after resume.
    expect(existsSync(join(markerDir, MARKERS.bDone))).toBe(true);
  }, 180_000);
});
