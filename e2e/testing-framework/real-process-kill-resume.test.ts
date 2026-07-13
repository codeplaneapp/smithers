import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fault, e2eHarness, realProcessAdapter, runScenario, scenario, step } from "@smithers-orchestrator/testing";

describe("testing framework real-process durability", () => {
  test("kills the real engine child at a task cut point and resumes in a fresh process", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-testing-process-"));
    const dbPath = join(root, "run.db"); const markerDir = join(root, "markers"); const counter = join(root, "counter.log");
    mkdirSync(markerDir, { recursive: true });
    const runner = fileURLToPath(new URL("../harness/engineChildRunner.ts", import.meta.url));
    let initialOutput = "";
    const spawnChild = (mode: "initial" | "resume") => { const processChild = spawn("bun", [runner, dbPath, "testing-framework-kill", mode, markerDir, counter, "60000"], { stdio: ["ignore", "pipe", "pipe"] }); if (mode === "initial") processChild.stdout?.on("data", (chunk) => { initialOutput += String(chunk); }); return processChild; };
    let child: ChildProcess | undefined; let resumed: ChildProcess | undefined;
    const started = join(markerDir, "B.started");
    try {
      const adapter = realProcessAdapter({ spawn: async () => {
        child = spawnChild("initial");
        const waitFor = async (predicate: () => boolean) => { const deadline = Date.now() + 5_000; while (!predicate() && Date.now() < deadline) await Bun.sleep(10); return predicate(); };
        await waitFor(() => existsSync(started));
        return { pid: child.pid!, child, handshake: () => waitFor(() => initialOutput.includes("SMITHERS_ENGINE_HANDSHAKE=runWorkflow")), kill: (signal?: string) => { child!.kill(signal as NodeJS.Signals | undefined); }, close: () => undefined, resume: async () => {
          resumed = spawnChild("resume");
          const resumedChild = resumed;
          await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("resume child did not exit within 30s")), 30_000); resumedChild.once("exit", () => { clearTimeout(timer); resolve(); }); resumedChild.once("error", (error) => { clearTimeout(timer); reject(error); }); });
          return { pid: resumedChild.pid!, child: resumedChild, handshake: () => true, kill: (signal?: string) => { resumedChild.kill(signal as NodeJS.Signals | undefined); }, close: () => undefined };
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
    } finally { for (const process of [child, resumed]) if (process?.pid && process.exitCode === null) process.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
  }, { timeout: 60_000 });
});
