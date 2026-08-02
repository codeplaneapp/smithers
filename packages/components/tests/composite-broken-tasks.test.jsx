/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { CheckSuite, ScanFixVerify, Supervisor } from "../src/components/index.js";
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smthrs/react-reconciler/context";
import { renderFrame } from "smthrs";
import { createTestSmithers } from "./helpers.js";
import { Effect } from "effect";

const boss = { id: "boss", generate: async () => ({ text: "ok" }) };
const worker = { id: "worker", generate: async () => ({ text: "ok" }) };
const scanner = { id: "scanner", generate: async () => ({ text: "ok" }) };
const fixer = { id: "fixer", generate: async () => ({ text: "ok" }) };
const verifier = { id: "verifier", generate: async () => ({ text: "ok" }) };

async function render(el) {
  const renderer = new SmithersRenderer();
  return renderer.render(el);
}

async function renderWithOutputs(el, outputs) {
  const ctx = new SmithersCtx({
    runId: "test-run",
    iteration: 0,
    input: {},
    outputs,
  });
  return render(<SmithersContext.Provider value={ctx}>{el}</SmithersContext.Provider>);
}

describe("Supervisor final summary task (finding 1)", () => {
  test("final summary runs on the boss agent, not as a static task", async () => {
    const result = await renderWithOutputs(
      <Supervisor
        id="boss"
        boss={boss}
        workers={{ docs: worker }}
        planOutput="plan_out"
        workerOutput="worker_out"
        reviewOutput="review_out"
        finalOutput="final_out"
      >
        plan work
      </Supervisor>,
      { plan_out: [{ nodeId: "boss-plan", iteration: 0, plan: "PLAN" }] },
    );
    const final = result.tasks.find((task) => task.nodeId === "boss-final");
    expect(final).toBeDefined();
    // Agent task: bound to boss, has a prompt, no static payload.
    expect(final.agent).toBe(boss);
    expect(typeof final.prompt).toBe("string");
    expect(final.prompt).toContain("Summarize");
    expect(final.staticPayload).toBeUndefined();
    expect(final.computeFn).toBeUndefined();
  });
});

describe("ScanFixVerify report task (finding 3)", () => {
  test("report runs on an agent, not as a static task", async () => {
    const result = await render(
      <ScanFixVerify
        id="sfv"
        scanner={scanner}
        fixer={fixer}
        verifier={verifier}
        scanOutput="scan_out"
        fixOutput="fix_out"
        verifyOutput="verify_out"
        reportOutput="report_out"
      />,
    );
    const report = result.tasks.find((task) => task.nodeId === "sfv-report");
    expect(report).toBeDefined();
    expect(report.agent).toBe(verifier);
    expect(typeof report.prompt).toBe("string");
    expect(report.prompt).toContain("summary report");
    expect(report.staticPayload).toBeUndefined();
    expect(report.computeFn).toBeUndefined();
  });
});

describe("CheckSuite verdict task (finding 2)", () => {
  test("verdict is a compute task that depends on every check", async () => {
    const result = await render(
      <CheckSuite
        id="checks"
        strategy="all-pass"
        verdictOutput="verdict_out"
        checks={[
          { id: "types", command: "pnpm typecheck" },
          { id: "tests", agent: worker, label: "Tests" },
        ]}
      />,
    );
    const verdict = result.tasks.find((task) => task.nodeId === "checks-verdict");
    expect(verdict).toBeDefined();
    // Compute task — not static, not agent.
    expect(typeof verdict.computeFn).toBe("function");
    expect(verdict.agent).toBeUndefined();
    expect(verdict.staticPayload).toBeUndefined();
    // Depends on every check (deps mechanism Task.js honors, not the ignored "needs").
    expect(new Set(verdict.dependsOn)).toEqual(new Set(["checks-types", "checks-tests"]));
  });

  /**
   * Render the CheckSuite inside a real Workflow + seeded SmithersCtx so the
   * verdict compute closure reads the actual per-check outputs, then invoke it.
   * @param {"all-pass" | "majority" | "any-pass"} strategy
   * @param {boolean[]} checkResults pass/fail per check, in declared order
   */
  async function computeVerdict(strategy, checkResults) {
    const { smithers, Workflow, outputs, cleanup } = createTestSmithers({
      verdict: z.object({ passed: z.boolean(), passCount: z.number(), total: z.number() }),
    });
    const checks = checkResults.map((_, i) => ({ id: `c${i}`, agent: worker }));
    const workflow = smithers(() => (
      <Workflow name="checksuite-verdict">
        <CheckSuite id="cs" strategy={strategy} verdictOutput={outputs.verdict} checks={checks} />
      </Workflow>
    ));
    const seededOutputs = {};
    seededOutputs.verdict = checkResults.map((passed, i) => ({
      runId: "verdict-run",
      nodeId: `cs-c${i}`,
      iteration: 0,
      passed,
      passCount: 0,
      total: 0,
    }));
    const frame = await Effect.runPromise(
      renderFrame(
        workflow,
        new SmithersCtx({
          runId: "verdict-run",
          iteration: 0,
          input: {},
          outputs: seededOutputs,
          zodToKeyName: workflow.zodToKeyName,
        }),
      ),
    );
    const verdict = frame.tasks.find((task) => task.nodeId === "cs-verdict");
    expect(verdict).toBeDefined();
    expect(typeof verdict.computeFn).toBe("function");
    const value = await verdict.computeFn();
    cleanup();
    return value;
  }

  test("all-pass: fails when any check fails, passes when all pass", async () => {
    expect((await computeVerdict("all-pass", [true, true, true])).passed).toBe(true);
    const mixed = await computeVerdict("all-pass", [true, false, true]);
    expect(mixed.passed).toBe(false);
    expect(mixed.passCount).toBe(2);
    expect(mixed.total).toBe(3);
  });

  test("any-pass: passes when at least one check passes", async () => {
    expect((await computeVerdict("any-pass", [false, false, true])).passed).toBe(true);
    expect((await computeVerdict("any-pass", [false, false, false])).passed).toBe(false);
  });

  test("majority: passes only when more than half pass", async () => {
    expect((await computeVerdict("majority", [true, true, false])).passed).toBe(true);
    expect((await computeVerdict("majority", [true, false, false])).passed).toBe(false);
    // Exactly half is not a majority.
    expect((await computeVerdict("majority", [true, false])).passed).toBe(false);
  });
});
