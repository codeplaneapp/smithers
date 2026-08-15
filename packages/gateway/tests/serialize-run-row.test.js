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

  test("projects persisted cancellation fields into the canonical source", () => {
    expect(
      serializeRunRow({
        run_id: "cancelled",
        cancel_request_id: "request-1",
        cancel_request_source: "signal",
        cancel_request_detail: "worker received SIGTERM",
        cancel_request_signal: "SIGTERM",
        cancel_request_client_identity: "operator",
        cancel_request_client_pid: 4242n,
      }).cancellationSource,
    ).toEqual({
      kind: "signal",
      detail: "worker received SIGTERM",
      signal: "SIGTERM",
      clientPid: 4242,
      requestId: "request-1",
      clientIdentity: "operator",
    });
  });

  test("normalizes legacy transports and omits missing or invalid attribution", () => {
    expect(
      serializeRunRow({
        runId: "legacy",
        cancelRequestSource: "websocket",
        cancelRequestId: "request-legacy",
      }).cancellationSource,
    ).toEqual({ kind: "rpc", detail: "websocket cancellation request", requestId: "request-legacy" });
    expect(serializeRunRow({ runId: "uncancelled", cancelRequestSource: null }).cancellationSource).toBeUndefined();
    expect(serializeRunRow({ runId: "bad", cancelRequestSource: "unknown" }).cancellationSource).toBeUndefined();
  });
});
