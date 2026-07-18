import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { buildKillResumeWorkflow } from "../harness/killResumeWorkflow.ts";
import { fault, e2eHarness, realProcessAdapter, runScenario, scenario, step } from "@smithers-orchestrator/testing";
import { makeEngineChildFixture } from "./testingProcessFixture.ts";

describe("testing framework real-process durability", () => {
  test("kills the real engine child at a task cut point and resumes in a fresh process", async () => {
    const fixture = makeEngineChildFixture("testing-framework-kill");
    try {
      const adapter = realProcessAdapter({ runnerPath: fixture.runnerPath, probe: fixture.probe, spawn: fixture.spawn });
      const result = await runScenario(scenario("real-process-restart", { steps: [step("resume", { runnerBinding: "e2e:kill-resume:durable-output:v1", run: (runtime) => runtime.effect("durable-output", () => "resumed") })], faults: [fault("sigkill", "during-task", "resume")] }), { harness: e2eHarness({ adapter }), waitBudget: 90_000 });
      expect(result.status).toBe("finished");
      expect(result.ambiguity.some((item) => item.outcome === "restart-in-task")).toBe(true);
      expect(result.ambiguity.some((item) => item.outcome === "effect-applied-journal-missing")).toBe(true);
      // The SIGKILL/resume observation arrived through the unified
      // operation/phase middleware as a durability transition receipt.
      const receipt = (result.trace.filter((event) => event.type === "durability").at(-1)?.data as { receipt?: { productionOperation?: string; invoked?: boolean; observation?: { terminatedBy?: string; resumed?: boolean } } } | undefined)?.receipt;
      expect(receipt?.productionOperation).toBe("runWorkflow");
      expect(receipt?.invoked).toBe(true);
      expect(receipt?.observation?.terminatedBy).toBe("SIGKILL");
      expect(receipt?.observation?.resumed).toBe(true);
      // Real production children: the admission probe exited cleanly without
      // executing the workflow, runStep's initial child observed its SIGKILL
      // terminal signal, and the fresh-process resume child (a distinct pid)
      // exited 0 after finishing the production run.
      const [probeChild, initialChild, resumedChild] = fixture.children;
      expect(fixture.children).toHaveLength(3);
      expect(probeChild?.exitCode).toBe(0);
      expect(initialChild?.signalCode).toBe("SIGKILL");
      expect(resumedChild?.exitCode).toBe(0);
      expect(initialChild?.pid).not.toBe(resumedChild?.pid);
      // Every tracked child is dead after runScenario's scoped cleanup.
      for (const child of fixture.children) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(readFileSync(join(fixture.markerDir, "B.done"), "utf8").length).toBeGreaterThan(0);
      const executions = readFileSync(fixture.counterFile, "utf8").trim().split(/\n/).filter(Boolean);
      // Pre-kill node A committed once and never re-ran; interrupted node B
      // ran twice (initial + resume) while committing exactly one output row.
      expect(executions.filter((id) => id === "node-a").length).toBe(1);
      expect(executions.filter((id) => id === "node-b").length).toBe(2);
      const reopened = new SmithersDb(new (await import("bun:sqlite")).Database(fixture.dbPath));
      try {
        const attempts = await Effect.runPromise(reopened.listAttemptsForRun("testing-framework-kill"));
        const bAttempts = attempts.filter((attempt) => attempt.nodeId === "node-b");
        expect(bAttempts.length).toBeGreaterThanOrEqual(2);
        expect(bAttempts.some((attempt) => attempt.state === "finished")).toBe(true);
        const outputFixture = buildKillResumeWorkflow({ dbPath: fixture.dbPath, markerDir: fixture.markerDir, counterFile: fixture.counterFile, mode: "resume" });
        try {
          const outputRows = await (outputFixture.db as unknown as { select: () => { from: (table: unknown) => Promise<readonly { nodeId?: string; value?: number }[]> } }).select().from(outputFixture.tables.b);
          const committed = outputRows.filter((row) => row.nodeId === "node-b" && row.value === 20);
          expect(committed.length).toBe(1);
        } finally { (outputFixture.db as unknown as { $client?: { close?: () => void } }).$client?.close?.(); }
      } finally { reopened.db.close(); }
    } finally { fixture.dispose(); }
  }, { timeout: 120_000 });
});
