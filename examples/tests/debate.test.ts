import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers debate", async () => {
  const result = await coverExample("../debate.jsx", {
    input: { question: "Adopt Smithers?", rounds: 2 },
    maxLoopIterations: 2,
    // The loop renders the next round before observing that two rounds completed.
    allowUnreached: ["for-round-3", "against-round-3"],
    mocks: {
      "*-round-*": ({ nodeId }: { nodeId: string }) => {
        const position = nodeId.startsWith("for-") ? "for" : "against";
        const round = Number(nodeId.at(-1));
        return {
          position, round,
          points: [{ claim: `${position} ${round}`, evidence: "test", strength: "strong" }],
          rebuttals: [], summary: `${position} argument`,
        };
      },
      verdict: {
        decision: "adopt", winner: "for", reasoning: "stronger evidence",
        conditions: ["measure"], risks: ["cost"], recommendation: "proceed",
      },
    },
  });

  expect(result.executed).toEqual([
    "for-round-1", "against-round-1", "for-round-2", "against-round-2", "verdict",
  ]);
  expect(result.taskOutputs["for-round-1"][0]).toMatchObject({ position: "for", round: 1 });
  expect(result.taskOutputs.verdict[0]).toMatchObject({ decision: "adopt", winner: "for" });
});
