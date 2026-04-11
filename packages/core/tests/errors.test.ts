import { describe, expect, test } from "bun:test";
import {
  EngineError,
  SmithersError,
  errorToJson,
  getSmithersErrorDefinition,
  isKnownSmithersErrorCode,
  knownSmithersErrorCodes,
  smithersErrorDefinitions,
  toSmithersError,
} from "../src/errors.ts";

describe("Smithers errors", () => {
  test("exports the reference error catalog", () => {
    expect(knownSmithersErrorCodes).toContain("MDX_PRELOAD_INACTIVE");
    expect(knownSmithersErrorCodes).toContain("TASK_HEARTBEAT_TIMEOUT");
    expect(knownSmithersErrorCodes).toContain("DB_WRITE_FAILED");
    expect(smithersErrorDefinitions.RUN_CANCELLED.category).toBe("engine");
    expect(isKnownSmithersErrorCode("OPENAPI_TOOL_EXECUTION_FAILED")).toBe(true);
    expect(getSmithersErrorDefinition("WORKTREE_EMPTY_PATH")?.category).toBe(
      "components",
    );
  });

  test("wraps errors while preserving code, details, operation, and cause", () => {
    const cause = new SmithersError("NODE_NOT_FOUND", "missing", { nodeId: "n1" });
    const wrapped = toSmithersError(cause, "resume", {
      details: { runId: "r1" },
    });

    expect(wrapped.code).toBe("NODE_NOT_FOUND");
    expect(wrapped.summary).toBe("resume: missing");
    expect(wrapped.details).toMatchObject({
      nodeId: "n1",
      runId: "r1",
      operation: "resume",
    });
    expect(wrapped.cause).toBe(cause);
  });

  test("normalizes EngineError and tagged errors", () => {
    const engine = toSmithersError(
      new EngineError({
        code: "TASK_TIMEOUT",
        message: "too slow",
        context: { nodeId: "a" },
      }),
    );
    expect(engine.code).toBe("TASK_TIMEOUT");
    expect(engine.details).toEqual({ nodeId: "a" });

    const tagged = toSmithersError({
      _tag: "TaskHeartbeatTimeout",
      message: "stale",
      nodeId: "a",
      iteration: 0,
      timeoutMs: 100,
    });
    expect(tagged.code).toBe("TASK_HEARTBEAT_TIMEOUT");
    expect(tagged.details).toMatchObject({ nodeId: "a", iteration: 0 });
  });

  test("serializes SmithersError fields", () => {
    const error = new SmithersError("INVALID_INPUT", "bad input", {
      field: "x",
    });
    expect(errorToJson(error)).toMatchObject({
      name: "SmithersError",
      code: "INVALID_INPUT",
      summary: "bad input",
      details: { field: "x" },
    });
  });
});
