import { expect, test } from "bun:test";

import { resolveHijackCandidate } from "../src/hijack.js";

test("resolveHijackCandidate recovers a native handoff from RunHijacked before attempt metadata flushes", async () => {
  const candidate = await resolveHijackCandidate(
    {
      listAttemptsForRun: async () => [],
      listEventsByType: async () => [
        {
          type: "RunHijacked",
          payloadJson: JSON.stringify({
            nodeId: "chat",
            iteration: 2,
            attempt: 3,
            engine: "codex",
            mode: "native-cli",
            resume: "thread-1",
            cwd: "/tmp/workspace",
          }),
        },
      ],
    },
    "run-1",
    "codex",
  );

  expect(candidate).toEqual({
    runId: "run-1",
    nodeId: "chat",
    iteration: 2,
    attempt: 3,
    engine: "codex",
    mode: "native-cli",
    resume: "thread-1",
    cwd: "/tmp/workspace",
  });
});
