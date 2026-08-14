/** @jsxImportSource smthrs */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderPrompt, renderWorkflow } from "smthrs/testing";

setDefaultTimeout(45_000);

type Descriptor = {
  nodeId: string;
  prompt?: unknown;
  staticPayload?: unknown;
  worktreePath?: string;
  worktreeBranch?: string;
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

const WORKFLOW = "finish-agentic-ui-library.tsx";
const FIX_IDS = [
  "conversation-foundation",
  "reasoning-tools",
  "agent-identity-context",
  "approvals-checkpoints",
  "sandbox-previews",
  "workflow-canvas",
];

describe("finish-agentic-ui-library workflow", () => {
  test("fix lanes mount immediately with seeded findings; later phases gate", async () => {
    const initial = await render(WORKFLOW, {}, {}, { runId: "Fin Run" });
    const manifest = task(initial, "agui-fin-manifest").staticPayload as { lanes: Array<{ laneId: string }> };
    expect(manifest.lanes).toHaveLength(9);
    const implement = task(initial, "fix-sandbox-previews-implement");
    expect(implement.worktreeBaseBranch).toBe("main");
    const implementPrompt = prompt(initial, "fix-sandbox-previews-implement");
    expect(implementPrompt).toContain("allow-scripts+allow-same-origin");
    expect(implementPrompt).toContain("backslash");
    expect(prompt(initial, "fix-conversation-foundation-implement")).toContain("Provider/Scroller");
    expect(optional(initial, "integration-implement")).toBeUndefined();
    expect(optional(initial, "adopt-chat-implement")).toBeUndefined();
    expect(optional(initial, "final-audit-fable")).toBeUndefined();
  });

  test("merges and integration mount after lanes settle; audits gate on integration", async () => {
    const laneResults = FIX_IDS.map((laneId) =>
      row(`fix-${laneId}-result`, 0, {
        laneId,
        branch: `agui-fin/fin-run/${laneId}`,
        worktreePath: `/tmp/fin/${laneId}`,
        lgtm: true,
        exhausted: false,
        attempts: 1,
        summary: `Fix lane ${laneId} LGTM.`,
        filesChanged: [],
        componentsImplemented: [],
        componentsDeferred: [],
        seatVerdicts: [],
      }),
    );
    const frame = await render(WORKFLOW, {}, { aguiLaneResult: laneResults }, { runId: "Fin Run" });
    const mergeText = prompt(frame, "merge-sandbox-previews");
    expect(mergeText).toContain("update-ref refs/heads/");
    expect(mergeText).toContain("merge-base --is-ancestor");
    expect(optional(frame, "integration-implement")).toBeUndefined();

    const merges = FIX_IDS.map((laneId) =>
      row(`merge-${laneId}`, 0, { laneId, mergedToMain: true, summary: `landed ${laneId}`, commandsRun: [] }),
    );
    const integrationFrame = await render(
      WORKFLOW,
      {},
      { aguiLaneResult: laneResults, aguiFinMerge: merges },
      { runId: "Fin Run" },
    );
    const integrationText = prompt(integrationFrame, "integration-implement");
    expect(integrationText).toContain("happy-dom");
    expect(integrationText).toContain("ChatTranscript");
    expect(optional(integrationFrame, "adopt-chat-implement")).toBeUndefined();
    expect(optional(integrationFrame, "final-audit-sol")).toBeUndefined();
  });
});
