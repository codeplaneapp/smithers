import { describe, expect, test } from "bun:test";
import { serializeRunRow } from "../src/api/serializeRunRow.js";

describe("serializeRunRow", () => {
  test("projects validated durable startedBy without exposing malformed attribution", () => {
    const row = serializeRunRow({
      runId: "run-1",
      configJson: JSON.stringify({
        gatewayWorkflowKey: "deploy",
        gatewaySystem: false,
        startedBy: { harness: "codex", sessionId: "thread-1", prompt: "explicit", detected: true },
      }),
    });
    expect(row).toMatchObject({
      workflowKey: "deploy",
      system: false,
      startedBy: { harness: "codex", sessionId: "thread-1", prompt: "explicit", detected: true },
    });
    expect(
      serializeRunRow({ runId: "bad", configJson: JSON.stringify({ startedBy: { harness: "codex", extra: true } }) })
        .startedBy,
    ).toBeUndefined();
  });

  test("projects immutable system visibility and fails historical rows closed", () => {
    expect(
      serializeRunRow({
        runId: "system",
        configJson: JSON.stringify({ gatewayWorkflowKey: "init", gatewaySystem: true }),
      }).system,
    ).toBe(true);
    expect(
      serializeRunRow({
        runId: "public",
        configJson: JSON.stringify({ gatewayWorkflowKey: "deploy", gatewaySystem: false }),
      }).system,
    ).toBe(false);
    expect(serializeRunRow({ runId: "legacy", configJson: "{}" }).system).toBe(true);
    expect(serializeRunRow({ runId: "malformed", configJson: "{" }).system).toBe(true);
  });
});
