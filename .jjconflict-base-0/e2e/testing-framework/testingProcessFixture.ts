import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { buildKillResumeWorkflow } from "../harness/killResumeWorkflow.ts";

/**
 * Real engineChildRunner spawn wiring for the testing-framework e2e suites: a
 * production runWorkflow child over an on-disk SmithersDb that can be
 * SIGKILLed mid-node and resumed in a fresh process. There are no echo
 * runners here — the durable-state observer reads the same database and
 * output tables the child actually writes, and the resumed child is a real
 * second OS process running the identical repository-owned runner.
 *
 * The fixture supplies TWO launch inputs matching the adapter's split
 * protocol: `probe` starts the runner in its admission mode (production db
 * bootstrap, `probe:<nonce>` handshake, exit 0, NO workflow execution), and
 * `spawn` starts the actual runWorkflow child that runStep verifies and holds
 * in flight. The adapter owns every nonce, verification, kill, and resume.
 */
export type EngineChildDurableState = Readonly<{ effectApplied: boolean; journalWritten: boolean; outputPersisted: boolean }>;
export type EngineChildResource = Readonly<{
  pid: number;
  child: ChildProcess;
  handshake: (nonce: string) => Promise<string>;
  kill: (signal?: string) => void;
  close: () => void;
  resume?: (nonce: string) => Promise<EngineChildResource>;
  resultStatus?: () => string | undefined;
  observeDurableState: () => Promise<EngineChildDurableState>;
}>;
export type EngineChildFixture = Readonly<{
  runnerPath: string;
  dbPath: string;
  markerDir: string;
  counterFile: string;
  /** Filesystem marker node B writes when the target workflow is mid-task. */
  startedMarker: string;
  probe: (nonce: string) => Promise<EngineChildResource>;
  spawn: (nonce: string) => Promise<EngineChildResource>;
  /** Durable-state read of the target run: attempts + committed output rows. */
  observe: () => Promise<EngineChildDurableState>;
  children: readonly ChildProcess[];
  dispose: () => void;
}>;

export const makeEngineChildFixture = (runId: string): EngineChildFixture => {
  const root = mkdtempSync(join(tmpdir(), "smithers-testing-process-fixture-"));
  const dbPath = join(root, "run.db");
  const markerDir = join(root, "markers");
  const counter = join(root, "counter.log");
  mkdirSync(markerDir, { recursive: true });
  const runnerPath = fileURLToPath(new URL("../harness/engineChildRunner.ts", import.meta.url));
  const children: ChildProcess[] = [];
  const started = join(markerDir, "B.started");
  const waitFor = async (predicate: () => boolean, description: string) => {
    const deadline = Date.now() + 30_000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
    if (!predicate()) throw new Error(`timed out waiting for ${description}`);
  };
  const observe = async (): Promise<EngineChildDurableState> => {
    const db = new SmithersDb(new (await import("bun:sqlite")).Database(dbPath));
    let fixture: ReturnType<typeof buildKillResumeWorkflow> | undefined;
    try {
      const attempts = await Effect.runPromise(db.listAttemptsForRun(runId));
      const b = attempts.filter((attempt) => attempt.nodeId === "node-b");
      fixture = buildKillResumeWorkflow({ dbPath, markerDir, counterFile: counter, mode: "resume" });
      const rows = await (fixture.db as unknown as { select: () => { from: (table: unknown) => Promise<readonly { nodeId?: string; value?: number }[]> } }).select().from(fixture.tables.b);
      const outputPersisted = rows.some((row) => row.nodeId === "node-b" && row.value === 20);
      const journalWritten = b.some((attempt) => attempt.state === "finished");
      return { effectApplied: existsSync(started), journalWritten, outputPersisted };
    } finally {
      (fixture?.db as unknown as { $client?: { close?: () => void } })?.$client?.close?.();
      db.db.close();
    }
  };
  const spawnChild = (mode: "initial" | "resume" | "probe", nonce: string) => {
    const child = spawn("bun", [runnerPath, dbPath, runId, mode, markerDir, counter, "60000", nonce], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    return child;
  };
  const probeResource = async (nonce: string): Promise<EngineChildResource> => {
    const child = spawnChild("probe", nonce);
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    // Return immediately: the ADAPTER authenticates the probe marker on its
    // own stdout listener and awaits the clean exit; the handshake callback
    // is only its liveness fallback.
    return {
      pid: child.pid!,
      child,
      handshake: async (expected: string) => { await waitFor(() => output.includes(`SMITHERS_ENGINE_HANDSHAKE=probe:${expected}`), "probe handshake"); return expected; },
      resultStatus: () => output.match(/PROBE_STATUS=([^\n]+)/)?.[1],
      kill: (signal?: string) => { child.kill(signal as NodeJS.Signals | undefined); },
      close: () => undefined,
      observeDurableState: observe,
    };
  };
  const spawnResource = async (nonce: string): Promise<EngineChildResource> => {
    const child = spawnChild("initial", nonce);
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    await waitFor(() => existsSync(started), "B.started");
    return {
      pid: child.pid!,
      child,
      handshake: async (expected: string) => { await waitFor(() => output.includes(`SMITHERS_ENGINE_HANDSHAKE=runWorkflow:${expected}`), "initial engine handshake"); return expected; },
      kill: (signal?: string) => { child.kill(signal as NodeJS.Signals | undefined); },
      close: () => undefined,
      observeDurableState: observe,
      resume: async (resumeNonce: string) => {
        const resumed = spawnChild("resume", resumeNonce);
        let resumedOutput = "";
        resumed.stdout?.on("data", (chunk) => { resumedOutput += String(chunk); });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("resume child did not exit within 30s")), 30_000);
          resumed.once("exit", () => { clearTimeout(timer); resolve(); });
          resumed.once("error", (error) => { clearTimeout(timer); reject(error); });
        });
        return {
          pid: resumed.pid!,
          child: resumed,
          handshake: async (nonce: string) => resumedOutput.includes(`SMITHERS_ENGINE_HANDSHAKE=runWorkflow:${nonce}`) ? nonce : "",
          resultStatus: () => resumedOutput.match(/RESULT_STATUS=([^\n]+)/)?.[1],
          kill: (signal?: string) => { resumed.kill(signal as NodeJS.Signals | undefined); },
          close: () => undefined,
          observeDurableState: observe,
        };
      },
    };
  };
  const dispose = () => {
    for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  };
  return { runnerPath, dbPath, markerDir, counterFile: counter, startedMarker: started, probe: probeResource, spawn: spawnResource, observe, children, dispose };
};
