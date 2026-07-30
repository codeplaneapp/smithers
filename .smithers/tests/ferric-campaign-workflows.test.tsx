/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";
import { publishMarkerPath } from "../components/ferric/PublishPipeline";
import { parseQueueRows } from "../components/ferric/QueueParse";
import { ferricSchemas } from "../components/ferric/ferricSchemas";

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

describe("ferric and accounts campaign components", () => {
  const componentFiles = [
    "accounts/accountAgents.ts",
    "accounts/accountPool.ts",
    "accounts/RefreshAccountUsage.tsx",
    "ferric/BenchTask.tsx",
    "ferric/CampaignGate.tsx",
    "ferric/Closeout.tsx",
    "ferric/ferricAgents.ts",
    "ferric/ferricConfig.ts",
    "ferric/ferricGates.ts",
    "ferric/ferricLedger.ts",
    "ferric/ferricSchemas.ts",
    "ferric/ferricShell.ts",
    "ferric/ferricSmithers.ts",
    "ferric/FoundationAndBudget.tsx",
    "ferric/FuzzTask.tsx",
    "ferric/PhaseGA.tsx",
    "ferric/PhaseM0.tsx",
    "ferric/PhaseM25.tsx",
    "ferric/PhaseM3.tsx",
    "ferric/PhaseM4.tsx",
    "ferric/PhaseM5M6.tsx",
    "ferric/PhaseM7.tsx",
    "ferric/PhaseM8.tsx",
    "ferric/PhaseM9.tsx",
    "ferric/PortCampaign.tsx",
    "ferric/PublishPipeline.tsx",
    "ferric/QueueParse.tsx",
    "ferric/Slice.tsx",
    "ferric/SuiteTask.tsx",
    "ferric/TrialPhase.tsx",
  ];
  test("every campaign component module loads and exports something", async () => {
    for (const file of componentFiles) {
      const mod = await import(join(import.meta.dir, "..", "components", file));
      expect(Object.keys(mod).length, `${file} has no exports`).toBeGreaterThan(0);
    }
  });

  test("rejects traversal publish idempotency keys at schema and path boundaries", () => {
    const idempotencyKey = "../../../../tmp/x";
    const decision = {
      artifact: "ferric-release",
      shouldPublish: true,
      reason: "Publish the verified release.",
      idempotencyKey,
    };

    expect(ferricSchemas.frcPublishDecision.safeParse(decision).success).toBe(false);
    expect(() => publishMarkerPath("/repo", idempotencyKey)).toThrow("Invalid publish idempotency key");
  });

  test("rejects shell metacharacters in queue module ids", () => {
    const queue = "order\tmodule\tloc\tfan_in\tscc\tdeps\tgating_tests\n1\tmodule;touch-pwned\t10\t0\t-\t\t";

    expect(() => parseQueueRows(queue)).toThrow(/D5_QUEUE_CONTRACT: module id .* must match/);
  });
});
