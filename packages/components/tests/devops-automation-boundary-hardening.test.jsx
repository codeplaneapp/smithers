/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { CheckSuite, DriftDetector, Kanban, ScanFixVerify } from "../src/components/index.js";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";

const RUN_ID = "devops-boundary-hardening";
const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const otherAgent = { id: "other", generate: async () => ({ text: "ok" }) };
const rogueAgent = { id: "rogue", generate: async () => ({ text: "ok" }) };

async function render(element, outputs = {}, ctxOverrides = {}) {
  const renderer = new SmithersRenderer();
  const ctx = new SmithersCtx({
    runId: RUN_ID,
    iteration: 0,
    input: {},
    outputs,
    ...ctxOverrides,
  });
  const graph = await renderer.render(<SmithersContext.Provider value={ctx}>{element}</SmithersContext.Provider>);
  return { graph, root: renderer.getRoot(), ctx };
}

function byId(graph, id) {
  const task = graph.tasks.find((entry) => entry.nodeId === id);
  expect(task).toBeDefined();
  return task;
}

function outputRow(nodeId, payload, iteration = 0) {
  return {
    runId: RUN_ID,
    nodeId,
    iteration,
    ...payload,
  };
}

describe("devops automation boundary hardening", () => {
  test("CheckSuite runs the command when a check declares both command and agent", async () => {
    const command = `${JSON.stringify(process.execPath)} -e "console.log('dual ok')"`;
    const { graph } = await render(
      <CheckSuite
        id="dual"
        verdictOutput="verdict_out"
        checks={[{ id: "both", command, agent, label: "Dual check" }]}
      />,
    );

    const check = byId(graph, "dual-both");
    // The command branch wins: the check becomes a compute task and the
    // agent must not leak onto it, or the engine would try to run both.
    expect(check.agent).toBeUndefined();
    expect(check.staticPayload).toBeUndefined();
    expect(typeof check.computeFn).toBe("function");
    await expect(check.computeFn()).resolves.toMatchObject({
      passed: true,
      command,
      exitCode: 0,
    });
    expect(check.label).toBe("Dual check");
  });

  test("ScanFixVerify falls back to ctx.iteration without an iterations map and wraps fixer rotation past the chain length", async () => {
    const { graph } = await render(
      <ScanFixVerify
        id="qa"
        scanner={agent}
        fixer={[agent, otherAgent]}
        verifier={agent}
        scanOutput="scan_out"
        fixOutput="fix_out"
        verifyOutput="verify_out"
        reportOutput="report_out"
        maxRetries={4}
      />,
      {
        scan_out: [
          outputRow("qa-scan", { issues: ["stale a", "stale b"] }, 0),
          outputRow("qa-scan", { issues: ["one", "two", "three"] }, 1),
        ],
      },
      // No `iterations` map: the component must fall back to the
      // context-wide iteration instead of reading the stale row 0.
      { iteration: 1 },
    );

    const fixIds = graph.tasks.map((entry) => entry.nodeId).filter((nodeId) => nodeId.startsWith("qa-fix"));
    expect(fixIds).toEqual(["qa-fix-0", "qa-fix-1", "qa-fix-2"]);
    expect(byId(graph, "qa-fix-0").agent).toEqual([agent, otherAgent]);
    expect(byId(graph, "qa-fix-1").agent).toEqual([otherAgent, agent]);
    // Issue index 2 wraps modulo the fixer chain length back to the start.
    expect(byId(graph, "qa-fix-2").agent).toEqual([agent, otherAgent]);
    expect(byId(graph, "qa-fix-2").prompt).toBe("Fix scan issue 3 of 3: three");
    expect(byId(graph, "qa-verify").dependsOn).toEqual(["qa-fix-0", "qa-fix-1", "qa-fix-2"]);
  });

  test("Kanban column task overrides cannot clobber the computed id, agent, output, or prompt at runtime", async () => {
    // ColumnTaskProps omits these keys in TypeScript only; a JS caller can
    // still pass them, so the spread order is the real guard.
    const { graph } = await render(
      <Kanban
        id="guard"
        columns={[
          {
            name: "todo",
            agent,
            output: "todo_out",
            task: {
              id: "evil",
              agent: rogueAgent,
              output: "evil_out",
              children: "evil prompt",
              label: "custom label",
              timeoutMs: 250,
            },
          },
        ]}
        useTickets={() => [{ id: "T1" }]}
      />,
    );

    expect(graph.tasks.map((entry) => entry.nodeId)).toEqual(["guard-todo-T1"]);
    expect(byId(graph, "guard-todo-T1")).toMatchObject({
      agent,
      outputTableName: "todo_out",
      prompt: 'Process item T1 in column "todo".',
      label: "custom label",
      timeoutMs: 250,
    });
  });

  test("DriftDetector rejects a NaN polling cap before creating the loop", async () => {
    await expect(
      render(
        <DriftDetector
          id="nan"
          captureAgent={agent}
          compareAgent={otherAgent}
          captureOutput="capture_out"
          compareOutput="compare_out"
          baseline="v1"
          poll={{ maxPolls: Number.NaN }}
        />,
      ),
    ).rejects.toThrow("DriftDetector poll.maxPolls must be a finite number.");
  });
});
