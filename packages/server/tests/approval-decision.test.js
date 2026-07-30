import { describe, expect, test } from "bun:test";
import { approvalDecision } from "../src/approvalDecision.js";

const { parseApprovalRequest, validateApprovalDecision } = approvalDecision;

describe("validateApprovalDecision option-bearing modes", () => {
  test("select request whose options were all malformed rejects any selection", () => {
    // Every option entry is malformed (missing label), so parseApprovalRequest
    // drops them all — validation must fail closed, not accept arbitrary keys.
    const request = parseApprovalRequest({ mode: "select", options: [{ key: "safe" }] }, null);
    expect(request.options).toEqual([]);
    const result = validateApprovalDecision(request, { selected: "anything-goes" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_REQUEST");
  });

  test("rank request whose options were all malformed rejects any ranking", () => {
    const request = parseApprovalRequest({ mode: "rank", options: [{ key: "safe" }] }, null);
    expect(request.options).toEqual([]);
    const result = validateApprovalDecision(request, { ranked: ["anything-goes"] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_REQUEST");
  });

  test("rank rejects mixed-type ranked arrays instead of silently sanitizing", () => {
    const request = parseApprovalRequest(
      { mode: "rank", options: [{ key: "canary", label: "Canary" }] },
      null,
    );
    // The ORIGINAL decision object is what approveNode persists, so a
    // non-string entry must be rejected, not stripped from a validation copy.
    const result = validateApprovalDecision(request, { ranked: ["canary", 7] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_REQUEST");
  });

  test("valid select and rank decisions still pass", () => {
    const select = parseApprovalRequest(
      { mode: "select", options: [{ key: "safe", label: "Safe" }] },
      null,
    );
    expect(validateApprovalDecision(select, { selected: "safe" }).ok).toBe(true);
    const rank = parseApprovalRequest(
      {
        mode: "rank",
        options: [
          { key: "a", label: "A" },
          { key: "b", label: "B" },
        ],
      },
      null,
    );
    expect(validateApprovalDecision(rank, { ranked: ["b", "a"] }).ok).toBe(true);
  });

  test("gate mode without options is unaffected", () => {
    const gate = parseApprovalRequest(null, "node-1");
    expect(validateApprovalDecision(gate, undefined).ok).toBe(true);
  });
});
