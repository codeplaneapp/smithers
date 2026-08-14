import { describe, expect, test } from "bun:test";
import { renderWorkflow } from "smthrs/testing";
import workflow, { INHERITED_MEMORY, INVESTIGATION_MEMORY, RESPONSE_MEMORY } from "../workflows/memory-recall-demo";

const workflowPath = `${import.meta.dir}/../workflows/memory-recall-demo.tsx`;

const triage = {
  classification: "billing retry",
  likelyCause: "missing idempotency key",
  knownFacts: ["duplicate invoices follow a retried request"],
  nextChecks: ["compare retry headers"],
};

const investigation = {
  findings: ["the retry path does not preserve the idempotency key"],
  verifiedCause: "the billing retry creates a second invoice",
  recommendedFix: "persist the key before retrying",
};

describe("memory recall demo", () => {
  test("renders the inherited triage policy exactly", async () => {
    const frame = await renderWorkflow(workflow, { workflowPath, input: {} });
    const task = frame.tasks.find((candidate) => candidate.nodeId === "triage");

    expect(task?.memoryConfig).toEqual(INHERITED_MEMORY);
  });

  test("replaces the inherited policy for investigation", async () => {
    const frame = await renderWorkflow(workflow, {
      workflowPath,
      input: {},
      outputs: { triage: [{ nodeId: "triage", iteration: 0, ...triage }] },
    });
    const task = frame.tasks.find((candidate) => candidate.nodeId === "investigation");

    expect(task?.memoryConfig).toEqual(INVESTIGATION_MEMORY);
  });

  test("fully opts the customer response out of memory", async () => {
    const frame = await renderWorkflow(workflow, {
      workflowPath,
      input: {},
      outputs: {
        triage: [{ nodeId: "triage", iteration: 0, ...triage }],
        investigation: [{ nodeId: "investigation", iteration: 0, ...investigation }],
      },
    });
    const task = frame.tasks.find((candidate) => candidate.nodeId === "customer-response");

    expect(task?.memoryConfig).toEqual(RESPONSE_MEMORY);
  });
});
