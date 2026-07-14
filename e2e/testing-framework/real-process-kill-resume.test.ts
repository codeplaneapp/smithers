import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { fault, e2eHarness, realProcessAdapter, runScenario, scenario, step } from "@smithers-orchestrator/testing";

describe("testing framework real-process durability", () => {
  test("kills the real engine child at a task cut point and resumes in a fresh process", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-testing-process-"));
    const dbPath = join(root, "run.db"); const markerDir = join(root, "markers"); const counter = join(root, "counter.log");
    mkdirSync(markerDir, { recursive: true });
    const runner = fileURLToPath(new URL("../harness/engineChildRunner.ts", import.meta.url));
    let initialOutput = "";
    const spawnChild = (mode: "initial" | "resume", nonce: string) => { const processChild = spawn("bun", [runner, dbPath, "testing-framework-kill", mode, markerDir, counter, "60000", nonce], { stdio: ["ignore", "pipe", "pipe"] }); if (mode === "initial") processChild.stdout?.on("data", (chunk) => { initialOutput += String(chunk); }); return processChild; };
    let child: ChildProcess | undefined; let resumed: ChildProcess | undefined;
    const started = join(markerDir, "B.started");
    try {
      const adapter = realProcessAdapter({ runnerPath: runner, spawn: async (nonce: string) => {
        child = spawnChild("initial", nonce);
        const waitFor = async (predicate: () => boolean, description: string) => { const deadline = Date.now() + 30_000; while (!predicate() && Date.now() < deadline) await Bun.sleep(10); if (!predicate()) throw new Error(`timed out waiting for ${description}`); };
        await waitFor(() => existsSync(started), "B.started");
        return { pid: child.pid!, child, handshake: async (expected: string) => { await waitFor(() => initialOutput.includes(`SMITHERS_ENGINE_HANDSHAKE=runWorkflow:${expected}`), "initial engine handshake"); return expected; }, kill: (signal?: string) => { child!.kill(signal as NodeJS.Signals | undefined); }, close: () => undefined, resume: async (resumeNonce: string) => {
          resumed = spawnChild("resume", resumeNonce);
          const resumedChild = resumed;
          let resumedOutput = "";
          resumedChild.stdout?.on("data", (chunk) => { resumedOutput += String(chunk); });
          await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("resume child did not exit within 30s")), 30_000); resumedChild.once("exit", () => { clearTimeout(timer); resolve(); }); resumedChild.once("error", (error) => { clearTimeout(timer); reject(error); }); });
          return { pid: resumedChild.pid!, child: resumedChild, handshake: async (nonce: string) => resumedOutput.includes(`SMITHERS_ENGINE_HANDSHAKE=runWorkflow:${nonce}`) ? nonce : "", resultStatus: () => resumedOutput.match(/RESULT_STATUS=([^\n]+)/)?.[1], kill: (signal?: string) => { resumedChild.kill(signal as NodeJS.Signals | undefined); }, close: () => undefined };
        } };
      } });
      const result = await runScenario(scenario("real-process-restart", { steps: [step("resume", { run: (runtime) => runtime.effect("durable-output", () => "resumed") })], faults: [fault("sigkill", "during-task", "resume")] }), { harness: e2eHarness({ adapter }), waitBudget: 30_000 });
      expect(result.status).toBe("finished");
      expect(result.ambiguity.some((item) => item.outcome === "restart-in-task")).toBe(true);
      const code = await new Promise<number | null>((resolve, reject) => { if (resumed!.exitCode !== null) return resolve(resumed!.exitCode); const timer = setTimeout(() => reject(new Error("resume child did not exit within 30s")), 30_000); resumed!.once("exit", (value) => { clearTimeout(timer); resolve(value); }); resumed!.once("error", (error) => { clearTimeout(timer); reject(error); }); });
      expect(code).toBe(0);
      expect(readFileSync(join(markerDir, "B.done"), "utf8").length).toBeGreaterThan(0);
      const executions = readFileSync(counter, "utf8").trim().split(/\n/).filter(Boolean);
      expect(executions.filter((id) => id === "node-b").length).toBe(2);
      const reopened = new SmithersDb(new (await import("bun:sqlite")).Database(dbPath));
      try {
        const attempts = await Effect.runPromise(reopened.listAttemptsForRun("testing-framework-kill"));
        const bAttempts = attempts.filter((attempt) => attempt.nodeId === "node-b");
        expect(bAttempts.length).toBeGreaterThanOrEqual(2);
        expect(bAttempts.some((attempt) => attempt.state === "finished")).toBe(true);
      } finally { reopened.db.close(); }
    } finally { for (const process of [child, resumed]) if (process?.pid && process.exitCode === null) process.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  }, { timeout: 60_000 });
});
