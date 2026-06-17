import { describe, expect, test } from "bun:test";
import { DEVTOOLS_PROTOCOL_VERSION } from "../src/devtools.js";
import {
  DEVTOOLS_ERROR_CODES,
  JUMP_TO_FRAME_ERROR_CODES,
  NODE_DIFF_ERROR_CODES,
  NODE_OUTPUT_ERROR_CODES,
} from "../src/errors/index.js";

function expectNoDuplicates(values) {
  expect(new Set(values).size).toBe(values.length);
}

describe("protocol runtime constants", () => {
  test("devtools protocol version is the v1 wire contract", () => {
    expect(DEVTOOLS_PROTOCOL_VERSION).toBe(1);
  });

  test("devtools error codes cover auth delta and backpressure failures", () => {
    expect(DEVTOOLS_ERROR_CODES).toEqual([
      "RunNotFound",
      "InvalidRunId",
      "FrameOutOfRange",
      "SeqOutOfRange",
      "BackpressureDisconnect",
      "Unauthorized",
      "InvalidDelta",
    ]);
  });

  test("node output error codes cover malformed rows and payload limits", () => {
    expect(NODE_OUTPUT_ERROR_CODES).toEqual([
      "InvalidRunId",
      "InvalidNodeId",
      "InvalidIteration",
      "RunNotFound",
      "NodeNotFound",
      "IterationNotFound",
      "NodeHasNoOutput",
      "SchemaConversionError",
      "MalformedOutputRow",
      "PayloadTooLarge",
    ]);
  });

  test("node diff error codes cover dirty worktrees and attempt states", () => {
    expect(NODE_DIFF_ERROR_CODES).toEqual([
      "InvalidRunId",
      "InvalidNodeId",
      "InvalidIteration",
      "RunNotFound",
      "NodeNotFound",
      "AttemptNotFound",
      "AttemptNotFinished",
      "VcsError",
      "WorkingTreeDirty",
      "DiffTooLarge",
    ]);
  });

  test("jump-to-frame error codes cover confirmation busy rate-limit and auth paths", () => {
    expect(JUMP_TO_FRAME_ERROR_CODES).toEqual([
      "InvalidRunId",
      "InvalidFrameNo",
      "RunNotFound",
      "FrameOutOfRange",
      "ConfirmationRequired",
      "Busy",
      "UnsupportedSandbox",
      "VcsError",
      "RewindFailed",
      "RateLimited",
      "Unauthorized",
    ]);
  });

  test("all error code lists are duplicate-free", () => {
    expectNoDuplicates(DEVTOOLS_ERROR_CODES);
    expectNoDuplicates(NODE_OUTPUT_ERROR_CODES);
    expectNoDuplicates(NODE_DIFF_ERROR_CODES);
    expectNoDuplicates(JUMP_TO_FRAME_ERROR_CODES);
  });

  test("run lookup failures use consistent code spelling", () => {
    for (const codes of [
      DEVTOOLS_ERROR_CODES,
      NODE_OUTPUT_ERROR_CODES,
      NODE_DIFF_ERROR_CODES,
      JUMP_TO_FRAME_ERROR_CODES,
    ]) {
      expect(codes).toContain("RunNotFound");
      expect(codes).toContain("InvalidRunId");
    }
  });

  test("diff and rewind VCS errors use consistent code spelling", () => {
    expect(NODE_DIFF_ERROR_CODES).toContain("VcsError");
    expect(JUMP_TO_FRAME_ERROR_CODES).toContain("VcsError");
  });
});
