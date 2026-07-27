import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers kanban", async () => {
  const result = await coverExample("../kanban.jsx", {
    input: { goal: "ship", directory: "." },
    mocks: {
      triage: {
        items: [{ id: "a", title: "A", description: "Do A", column: "backlog" }],
        totalItems: 1,
      },
      "work-a": { itemId: "a", column: "review", summary: "done", filesChanged: [] },
      "review-a": {
        itemId: "a",
        approved: true,
        feedback: "ok",
        column: "done",
      },
    },
    maxLoopIterations: 2,
  });

  expect(result.executed).toEqual(["triage", "work-a", "review-a", "board"]);
  expect(result.taskOutputs["work-a"]).toHaveLength(1);
});
