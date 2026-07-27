import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers chat-log-repro", async () => {
  const result = await coverExample("../chat-log-repro.jsx", {
    mocks: {
      "claude-task": { agent: "claude", filesChanged: 1, summary: "created file" },
      "codex-task": { agent: "codex", filesChanged: 1, summary: "created file" },
    },
  });

  expect(result.executed).toEqual(["claude-task", "codex-task"]);
  expect(result.taskOutputs["claude-task"][0]).toMatchObject({ agent: "claude", filesChanged: 1 });
  expect(result.taskOutputs["codex-task"][0]).toMatchObject({ agent: "codex", filesChanged: 1 });
});
