import { describe, expect, test } from "bun:test";
import { serializeApprovalRow } from "../src/api/serializeApprovalRow.js";

describe("serializeApprovalRow", () => {
  test("falls back to request_json for title, summary, mode, options, scopes, users, and autoApprove", () => {
    const requestJson = JSON.stringify({
      title: "Deploy to prod",
      summary: "Ships build 42",
      mode: "select",
      options: [{ key: "blue", label: "Blue" }],
      allowedScopes: ["deploy"],
      allowedUsers: ["alice"],
      autoApprove: { after: 60_000, audit: true },
    });
    const api = serializeApprovalRow({
      run_id: "run-1",
      node_id: "gate",
      iteration: 2,
      requested_at_ms: 1_000,
      request_json: requestJson,
    });
    expect(api).toEqual({
      runId: "run-1",
      nodeId: "gate",
      iteration: 2,
      requestTitle: "Deploy to prod",
      requestSummary: "Ships build 42",
      requestedAtMs: 1_000,
      approvalMode: "select",
      options: [{ key: "blue", label: "Blue" }],
      allowedScopes: ["deploy"],
      allowedUsers: ["alice"],
      autoApprove: { after: 60_000, audit: true },
    });
  });

  test("explicit columns take precedence over request_json fallbacks", () => {
    const api = serializeApprovalRow({
      run_id: "run-1",
      node_id: "gate",
      iteration: 0,
      request_title: "Column title",
      approval_mode: "rank",
      request_json: JSON.stringify({ title: "JSON title", mode: "select" }),
    });
    expect(api.requestTitle).toBe("Column title");
    expect(api.approvalMode).toBe("rank");
  });

  test("malformed and non-object request_json degrade to no fallback fields", () => {
    for (const requestJson of ["{", JSON.stringify(["not", "an", "object"]), JSON.stringify("text"), null, undefined]) {
      const api = serializeApprovalRow({
        run_id: "run-1",
        node_id: "gate",
        request_json: requestJson,
      });
      expect(api.requestTitle).toBeUndefined();
      expect(api.approvalMode).toBeUndefined();
      expect(api.options).toBeUndefined();
      expect(api.allowedScopes).toBeUndefined();
      expect(api.allowedUsers).toBeUndefined();
      expect(api.autoApprove).toBeUndefined();
    }
  });

  test("defaults iteration to 0 and requestedAtMs to null", () => {
    const api = serializeApprovalRow({
      run_id: "run-1",
      node_id: "gate",
      iteration: null,
    });
    expect(api.iteration).toBe(0);
    expect(api.requestedAtMs).toBeNull();
  });

  test("workflowKey is omitted when absent and kept when present", () => {
    const without = serializeApprovalRow({ run_id: "run-1", node_id: "gate" });
    expect("workflowKey" in without).toBe(false);
    const withKey = serializeApprovalRow({
      run_id: "run-1",
      node_id: "gate",
      workflow_key: "wf-1",
    });
    expect(withKey.workflowKey).toBe("wf-1");
  });

  test("normalizes bigint columns to safe numbers and unsafe bigints to strings", () => {
    const api = serializeApprovalRow({
      run_id: "run-1",
      node_id: "gate",
      iteration: 3n,
      requested_at_ms: 9_007_199_254_740_993n,
    });
    expect(api.iteration).toBe(3);
    expect(api.requestedAtMs).toBe("9007199254740993");
  });
});
