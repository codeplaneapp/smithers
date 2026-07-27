import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["gather-context", "generate-answers", "validate"]) {
  mock.module(`../prompts/survey-answerer-agent/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers survey-answerer-agent", async () => {
  const result = await coverExample("../survey-answerer-agent.jsx", {
    input: { questions: [{ id: "q1", text: "Ready?" }] },
    mocks: {
      "gather-context": {
        documentSummaries: [], keyFacts: { ready: "yes" }, summary: "context",
      },
      "generate-answers": {
        answers: [{
          questionId: "q1", questionText: "Ready?", answer: "Yes",
          confidence: "high", sourceRefs: ["doc"], reasoning: "supported",
        }],
        unanswered: [], summary: "answered",
      },
      validate: {
        overallConsistency: "pass", contradictions: [], unsupportedClaims: [],
        revisedAnswers: [], summary: "valid",
      },
    },
  });

  expect(result.executed).toEqual(["gather-context", "generate-answers", "validate"]);
  expect(result.taskOutputs["generate-answers"][0]).toMatchObject({
    answers: [{ questionId: "q1", answer: "Yes", confidence: "high" }],
    unanswered: [],
  });
  expect(result.taskOutputs.validate[0]).toMatchObject({ overallConsistency: "pass" });
});
