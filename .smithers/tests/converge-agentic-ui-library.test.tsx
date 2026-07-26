/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderPrompt, renderWorkflow } from "smithers-orchestrator/testing";

setDefaultTimeout(45_000);

type Descriptor = {
  nodeId: string;
  prompt?: unknown;
  staticPayload?: unknown;
  worktreeBaseBranch?: string;
  [key: string]: unknown;
};
type Frame = { tasks: readonly Descriptor[]; toXml(): string };

const workflows = join(import.meta.dir, "..", "workflows");
const pathFor = (name: string) => join(workflows, name);
const render = async (
  name: string,
  input: unknown = {},
  outputs: Record<string, unknown[]> = {},
  extra: Record<string, unknown> = {},
) =>
  (await renderWorkflow((await import(pathFor(name))).default, {
    input,
    outputs,
    workflowPath: pathFor(name),
    ...extra,
  })) as unknown as Frame;
const baseId = (id: string) => id.split("@@", 1)[0] ?? id;
const optional = (frame: Frame, id: string) => frame.tasks.find((candidate) => baseId(candidate.nodeId) === id);
const task = (frame: Frame, id: string) => {
  const found = optional(frame, id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};
const prompt = (frame: Frame, id: string) => renderPrompt(task(frame, id).prompt);
const row = (nodeId: string, iteration: number, value: Record<string, unknown>) => ({
  nodeId,
  iteration,
  iterationCount: iteration,
  ...value,
});

const WORKFLOW = "converge-agentic-ui-library.tsx";
const LANE_IDS = ["workflow-canvas"];

describe("converge-agentic-ui-library workflow", () => {
  test("lanes graft prior branches under a scope-locked review contract", async () => {
    const initial = await render(WORKFLOW, {}, {}, { runId: "Conv Run" });
    const implement = prompt(initial, "conv-workflow-canvas-implement");
    expect(implement).toContain("agui-conv/run-1784718901085/workflow-canvas");
    expect(implement).toContain("CLOSED FINDINGS LIST");
    expect(implement).toContain("editable mutations");
    const dual = (await import(pathFor(WORKFLOW))) as { CONVERGE_LANES: Array<{ id: string; seats: string[] }> };
    expect(dual.CONVERGE_LANES.find((lane) => lane.id === "workflow-canvas")!.seats).toEqual(["fable", "sol"]);
    expect(optional(initial, "closure-implement")).toBeUndefined();
    expect(optional(initial, "cross-adopt-gateway-fable")).toBeUndefined();
  });

  test("review prompt locks scope; closure and cross-seat gate on merges", async () => {
    const laneRows = LANE_IDS.map((laneId) =>
      row(`conv-${laneId}-result`, 0, {
        laneId,
        branch: `agui-conv/conv-run/${laneId}`,
        worktreePath: `/tmp/conv/${laneId}`,
        lgtm: true,
        exhausted: false,
        attempts: 1,
        summary: `Lane ${laneId} LGTM.`,
        seatVerdicts: [],
      }),
    );
    const withLanes = await render(WORKFLOW, {}, { aguiConvLane: laneRows }, { runId: "Conv Run" });
    expect(prompt(withLanes, "merge-workflow-canvas")).toContain("update-ref refs/heads/");
    expect(optional(withLanes, "closure-implement")).toBeUndefined();

    const merges = LANE_IDS.map((laneId) =>
      row(`merge-${laneId}`, 0, { laneId, mergedToMain: true, summary: `landed ${laneId}`, commandsRun: [] }),
    );
    const withMerges = await render(
      WORKFLOW,
      {},
      { aguiConvLane: laneRows, aguiConvMerge: merges },
      { runId: "Conv Run" },
    );
    const closure = prompt(withMerges, "closure-implement");
    expect(closure).toContain("MonitorButton");
    expect(closure).toContain("hookComponents.test.tsx");
    expect(optional(withMerges, "cross-adopt-gateway-fable")).toBeUndefined();

    const closureGreen = {
      aguiImpl: [
        row("closure-implement@@closure-loop=0", 0, {
          laneId: "closure",
          status: "implemented",
          summary: "closure complete and gates pass",
          filesChanged: ["packages/gateway-ui/src/MonitorButton.tsx"],
          componentsImplemented: [],
          componentsDeferred: [],
        }),
      ],
      aguiCi: [
        row("closure-ci@@closure-loop=0", 0, { scope: "smithers", allPassed: true, summary: "green", commands: [] }),
      ],
    };
    const withClosure = await render(
      WORKFLOW,
      {},
      { aguiConvLane: laneRows, aguiConvMerge: merges, ...closureGreen },
      { runId: "Conv Run" },
    );
    const cross = prompt(withClosure, "cross-adopt-gateway-fable");
    expect(cross).toContain("ALREADY-LANDED");
    expect(cross).toContain("/Users/williamcory/multi");
    expect(optional(withClosure, "agui-conv-report")).toBeUndefined();
  });
});
