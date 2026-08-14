/** @jsxImportSource smthrs */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow, simulate, type RenderedWorkflow } from "smthrs/testing";

const workflowPath = join(import.meta.dir, "..", "workflows", "finish-campaigns.tsx");
let nonce = 0;
const moduleFor = async () => import(`${workflowPath}?fc=${++nonce}`);

type MockArgs = { nodeId: string; iteration: number };

const workRow = { summary: "worked", actionsTaken: ["did a thing"], blocked: false, blockReason: null };
const verifyRow = (done: boolean, remaining: string[] = []) => ({ done, remaining, evidence: "checked with commands" });

function loopUntil(frame: RenderedWorkflow, id: string): string | undefined {
  const visit = (node: any): any =>
    node?.tag === "smithers:ralph" && node.props?.id === id
      ? node.props
      : (node?.children ?? []).map(visit).find(Boolean);
  return visit(JSON.parse(frame.toXml()))?.until;
}

describe("finish-campaigns workflow", () => {
  test("input schema applies campaign defaults and rejects unsafe bounds", async () => {
    const { inputSchema } = await moduleFor();
    expect(inputSchema.parse({})).toEqual({
      tfRunId: "tf-final-replay-identity-20260718",
      uiRunId: "run-1784453941803",
      maxIterations: 12,
    });
    expect(inputSchema.safeParse({ tfRunId: " " }).success).toBe(false);
    expect(inputSchema.safeParse({ uiRunId: " " }).success).toBe(false);
    expect(inputSchema.safeParse({ maxIterations: 0 }).success).toBe(false);
    expect(inputSchema.safeParse({ maxIterations: 31 }).success).toBe(false);
  });

  test("first frame runs both campaign lanes in parallel", async () => {
    const workflow = (await moduleFor()).default;
    const frame = await renderWorkflow(workflow, { input: {}, outputs: {}, workflowPath });
    const nodeIds = frame.tasks.map(({ nodeId }) => nodeId);
    expect(nodeIds).toContain("tf-work");
    expect(nodeIds).toContain("ui-work");
    expect(loopUntil(frame, "tf-loop")).toBe("false");
    expect(loopUntil(frame, "ui-loop")).toBe("false");
  });

  test("a done verification closes its lane loop", async () => {
    const workflow = (await moduleFor()).default;
    const frame = await renderWorkflow(workflow, {
      input: {},
      outputs: {
        tfVerify: [{ nodeId: "tf-verify", iteration: 0, iterationCount: 0, ...verifyRow(true) }],
        uiVerify: [{ nodeId: "ui-verify", iteration: 0, iterationCount: 0, ...verifyRow(false, ["still landing"]) }],
      },
      workflowPath,
    });
    expect(loopUntil(frame, "tf-loop")).toBe("true");
    expect(loopUntil(frame, "ui-loop")).toBe("false");
  });

  test("lanes converge, thread verifier feedback into the next prompt, and reach the report", async () => {
    const workflow = (await moduleFor()).default;
    const simulation = simulate(workflow, {
      input: { maxIterations: 3 },
      workflowPath,
      mocks: {
        "*": ({ nodeId, iteration }: MockArgs) => {
          if (nodeId.endsWith("-work")) return workRow;
          if (nodeId.endsWith("-verify")) {
            return iteration === 0 ? verifyRow(false, ["REMAINING_SENTINEL"]) : verifyRow(true);
          }
          if (nodeId === "push-approval") return { approved: true, note: null };
          if (nodeId === "push-main") return { pushed: true, summary: "pushed main" };
          if (nodeId === "final-report") return { summary: "all done", tfDone: true, uiDone: true, followUps: [] };
          throw new Error(`unexpected node ${nodeId}`);
        },
      },
    });
    await simulation.run();
    for (const lane of ["tf", "ui"]) {
      expect(simulation.executed.filter((id) => id === `${lane}-work`)).toHaveLength(2);
      expect(simulation.executed.filter((id) => id === `${lane}-verify`)).toHaveLength(2);
      expect(simulation.task(`${lane}-work`).prompts[1]).toContain("REMAINING_SENTINEL");
    }
    // The push approval is a durable human gate: the sim suspends there, so
    // neither the push nor the closing report may have run.
    expect(simulation.executed).not.toContain("push-main");
    expect(simulation.executed).not.toContain("final-report");
  });

  test("an approved push gate mounts the push task; a denial skips straight to the report", async () => {
    const workflow = (await moduleFor()).default;
    const doneOutputs = {
      tfVerify: [{ nodeId: "tf-verify", iteration: 0, iterationCount: 0, ...verifyRow(true) }],
      uiVerify: [{ nodeId: "ui-verify", iteration: 0, iterationCount: 0, ...verifyRow(true) }],
    };
    const approved = await renderWorkflow(workflow, {
      input: {},
      outputs: {
        ...doneOutputs,
        pushApproval: [{ nodeId: "push-approval", iteration: 0, approved: true, note: null }],
      },
      workflowPath,
    });
    expect(approved.tasks.map(({ nodeId }) => nodeId)).toContain("push-main");
    const denied = await renderWorkflow(workflow, {
      input: {},
      outputs: {
        ...doneOutputs,
        pushApproval: [{ nodeId: "push-approval", iteration: 0, approved: false, note: "not yet" }],
      },
      workflowPath,
    });
    const deniedIds = denied.tasks.map(({ nodeId }) => nodeId);
    expect(deniedIds).not.toContain("push-main");
    expect(deniedIds).toContain("final-report");
  });
});
