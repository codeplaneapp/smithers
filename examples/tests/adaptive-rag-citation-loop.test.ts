import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers adaptive-rag-citation-loop", async () => {
  let routes = 0;
  let grades = 0;
  const result = await coverExample("../adaptive-rag-citation-loop.jsx", {
    inputs: [{ question: "retrieved?" }, { question: "memory?" }],
    maxLoopIterations: 2,
    approvals: "approve",
    mocks: {
      "route-query": () => ({
        mode: routes++ === 0 ? "retrieve" : "answer-from-memory",
        reason: "test route",
        risk: "low",
      }),
      "plan-retrieval": {
        subqueries: ["query"],
        sources: ["vector"],
        mustCite: true,
        gapsToClose: [],
      },
      "citation-judge": () => {
        const grounded = grades++ === 1;
        return { grounded, score: grounded ? 0.9 : 0.5, missingEvidence: [], unsupportedSentences: [] };
      },
    },
    expectedNodes: [
      "route-query", "plan-retrieval", "vector-search", "keyword-search", "source-fetch",
      "draft-answer", "citation-judge", "repair-retrieval-plan", "human-review", "final-answer",
    ],
  });

  expect(result.executed).toEqual([
    "route-query", "plan-retrieval", "vector-search", "keyword-search", "source-fetch",
    "draft-answer", "citation-judge", "repair-retrieval-plan",
    "vector-search", "keyword-search", "source-fetch", "draft-answer", "citation-judge",
    "final-answer", "human-review",
    "route-query", "draft-answer", "citation-judge", "draft-answer", "citation-judge", "human-review", "final-answer",
  ]);
  expect(result.approvals).toEqual([
    expect.objectContaining({ nodeId: "human-review", approved: true }),
    expect.objectContaining({ nodeId: "human-review", approved: true }),
  ]);
  expect(result.taskOutputs["citation-judge"]).toHaveLength(4);
});
