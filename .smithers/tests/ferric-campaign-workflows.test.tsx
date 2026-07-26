/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";

const workflowsDir = join(import.meta.dir, "..", "workflows");
let nonce = 0;
const moduleFor = async (name: string) => import(`${join(workflowsDir, name)}?fc=${++nonce}`);

describe("ultrafusion workflow", () => {
  test("first frame opens with the framing task", async () => {
    const workflowPath = join(workflowsDir, "ultrafusion.tsx");
    const workflow = (await moduleFor("ultrafusion.tsx")).default;
    const frame = await renderWorkflow(workflow, {
      input: { prompt: "Ship a durable release pipeline for the ferric campaign." },
      outputs: {},
      workflowPath,
    });
    const nodeIds = frame.tasks.map(({ nodeId }) => nodeId);
    expect(nodeIds).toContain("frame");
    // Fusion and roster stages wait on lane output; nothing downstream mounts
    // runnable before the brief exists.
    expect(nodeIds).not.toContain("fusion");
    expect(frame.toXml()).toContain('"name":"ultrafusion"');
  });
});

describe("react-rust-port workflow", () => {
  test("constructs and renders its campaign frame", async () => {
    const workflowPath = join(workflowsDir, "react-rust-port.tsx");
    const workflow = (await moduleFor("react-rust-port.tsx")).default;
    // PhaseM0 reads ctx.outputs.frcDocReview without a guard; the engine seeds
    // registered tables, the test harness does not, so seed the bare read.
    const frame = await renderWorkflow(workflow, { input: {}, outputs: { frcDocReview: [] }, workflowPath });
    expect(frame.toXml()).toContain('"name":"react-rust-port"');
    expect(frame.tasks.length).toBeGreaterThan(0);
  });
});
