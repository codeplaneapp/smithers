import { describe, expect, test } from "bun:test";
import {
  __humanRequestInternals,
  buildAgentAskRequestRow,
  getHumanTaskPrompt,
  isHumanRequestPastTimeout,
  validateHumanRequestValue,
} from "../src/human-requests.js";

describe("buildAgentAskRequestRow non-default parameter combinations", () => {
  test("carries kind, schemaJson, optionsJson and timeoutAtMs through unchanged", () => {
    const schemaJson = JSON.stringify({ type: "object", properties: { pick: { type: "string" } } });
    const optionsJson = JSON.stringify(["staging", "prod"]);
    const row = buildAgentAskRequestRow({
      runId: "run-1",
      nodeId: "node-a",
      iteration: 3,
      prompt: "Which environment?",
      unique: "ask-9",
      requestedAtMs: 2_000,
      kind: "select",
      schemaJson,
      optionsJson,
      timeoutAtMs: 7_000,
    });
    expect(row).toEqual({
      requestId: "human:run-1:node-a:3:ask-9",
      runId: "run-1",
      nodeId: "node-a",
      iteration: 3,
      kind: "select",
      status: "pending",
      prompt: "Which environment?",
      schemaJson,
      optionsJson,
      responseJson: null,
      requestedAtMs: 2_000,
      answeredAtMs: null,
      answeredBy: null,
      timeoutAtMs: 7_000,
    });
  });

  test("explicit nulls stay null rather than turning into defaults", () => {
    const row = buildAgentAskRequestRow({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      prompt: "p",
      unique: "u",
      requestedAtMs: 1,
      kind: "confirm",
      schemaJson: null,
      optionsJson: null,
      timeoutAtMs: null,
    });
    expect(row.kind).toBe("confirm");
    expect(row.schemaJson).toBeNull();
    expect(row.optionsJson).toBeNull();
    expect(row.timeoutAtMs).toBeNull();
  });
});

describe("isHumanRequestPastTimeout boundaries", () => {
  test("a timeout exactly at now counts as expired (<= boundary)", () => {
    expect(isHumanRequestPastTimeout({ timeoutAtMs: 11 }, 11)).toBe(true);
  });

  test("a NaN timeout never expires", () => {
    expect(isHumanRequestPastTimeout({ timeoutAtMs: Number.NaN }, 11)).toBe(false);
  });

  test("defaults now to the wall clock: a past timeout expires, a far-future one does not", () => {
    expect(isHumanRequestPastTimeout({ timeoutAtMs: 1 })).toBe(true);
    expect(isHumanRequestPastTimeout({ timeoutAtMs: Date.now() + 86_400_000 })).toBe(false);
  });
});

describe("getHumanTaskPrompt non-string prompt", () => {
  test("a non-string prompt value falls back", () => {
    expect(getHumanTaskPrompt({ prompt: 42 }, "fallback")).toBe("fallback");
    expect(getHumanTaskPrompt({ prompt: { text: "hi" } }, "fallback")).toBe("fallback");
  });
});

describe("validation issue formatting", () => {
  test("a root-level type mismatch reports the (root) path in the message", () => {
    const result = validateHumanRequestValue(
      { requestId: "r-root", schemaJson: JSON.stringify({ type: "object", properties: {} }) },
      "not an object",
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("HUMAN_REQUEST_VALIDATION_FAILED");
    expect(result.message).toContain("(root):");
  });

  test("formatValidationIssues joins issues and defaults missing paths/messages", () => {
    const message = __humanRequestInternals.formatValidationIssues({
      issues: [
        { path: ["a", "b"], message: "bad" },
        { path: [], message: undefined },
      ],
    });
    expect(message).toBe("a.b: bad; (root): invalid value");
  });
});
