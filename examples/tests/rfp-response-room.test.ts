import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["parse", "plan", "draft", "review", "package"]) {
  mock.module(`../prompts/rfp-response-room/${name}.mdx`, () => ({ default: Prompt }));
}

const mocks = {
  "parse-rfp": {
    opportunityName: "Enterprise", customer: "Acme", dueDate: "2026-08-01",
    requirements: [
      { id: "SEC-1", section: "Security", question: "Encrypted?", mandatory: true, topic: "security" },
      { id: "LEG-1", section: "Legal", question: "Terms?", mandatory: true, topic: "legal" },
    ],
    submissionInstructions: ["markdown"],
  },
  "build-answer-plan": {
    workstreams: [], sourceCollections: ["approved"], risks: [],
  },
  "draft-*": ({ nodeId }: { nodeId: string }) => ({
    requirementId: nodeId.slice(6).toUpperCase(), topic: "security", answer: "Yes",
    citedSourceIds: ["source-1"], confidence: 0.5, needsSME: true,
  }),
  "security-review": { reviewerRole: "security", approved: true, requirementIds: ["SEC-1"], blockers: [], suggestedEdits: [] },
  "legal-review": { reviewerRole: "legal", approved: true, requirementIds: ["LEG-1"], blockers: [], suggestedEdits: [] },
  "product-review": { reviewerRole: "product", approved: true, requirementIds: [], blockers: [], suggestedEdits: [] },
  "package-proposal": { files: ["proposal.md"], openQuestions: [], submissionReady: true, summary: "ready" },
};

test("covers rfp-response-room approval paths", async () => {
  const approved = await coverExample("../rfp-response-room.jsx", {
    mocks, approvals: "approve",
    expectedNodes: [
      "parse-rfp", "build-answer-plan", "draft-sec-1", "draft-leg-1",
      "security-review", "legal-review", "product-review", "sme-review", "package-proposal",
    ],
  });
  const denied = await coverExample("../rfp-response-room.jsx", {
    mocks, approvals: "deny", assert: false,
  });

  expect(approved.executed).toEqual([
    "parse-rfp", "build-answer-plan", "draft-sec-1", "draft-leg-1",
    "security-review", "legal-review", "product-review", "sme-review", "package-proposal",
  ]);
  expect(approved.taskOutputs["draft-sec-1"]).toHaveLength(1);
  expect(denied.executed.at(-1)).toBe("sme-review");
  expect(denied.approvals[0]).toMatchObject({ approved: false });
});
