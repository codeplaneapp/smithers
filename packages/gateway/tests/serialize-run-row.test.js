import { describe, expect, test } from "bun:test";
import { serializeRunRow } from "../src/api/serializeRunRow.js";

describe("serializeRunRow", () => {
  test("projects validated durable startedBy without exposing malformed attribution", () => {
    const row = serializeRunRow({
      runId: "run-1",
      configJson: JSON.stringify({
        gatewayWorkflowKey: "deploy",
        startedBy: { harness: "codex", sessionId: "thread-1", prompt: "explicit", detected: true },
      }),
    });
    expect(row).toMatchObject({
      workflowKey: "deploy",
      startedBy: { harness: "codex", sessionId: "thread-1", prompt: "explicit", detected: true },
    });
    expect(
      serializeRunRow({ runId: "bad", configJson: JSON.stringify({ startedBy: { harness: "codex", extra: true } }) })
        .startedBy,
    ).toBeUndefined();
  });
});
