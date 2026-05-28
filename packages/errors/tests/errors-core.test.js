import { describe, expect, test } from "bun:test";
import {
  AgentCliError,
  DbWriteFailed,
  EngineError,
  ERROR_REFERENCE_URL,
  InvalidInput,
  RunNotFound,
  SmithersError,
  TaskAborted,
  TaskHeartbeatTimeout,
  TaskTimeout,
  WorkflowFailed,
  errorToJson,
  fromTaggedError,
  fromTaggedErrorPayload,
  getSmithersErrorDefinition,
  getSmithersErrorDocsUrl,
  isKnownSmithersErrorCode,
  isSmithersError,
  isSmithersTaggedError,
  isSmithersTaggedErrorTag,
  knownSmithersErrorCodes,
  smithersErrorDefinitions,
  smithersTaggedErrorCodes,
  toSmithersError,
  toTaggedErrorPayload,
} from "../src/index.js";

const taggedCases = [
  {
    tag: "TaskAborted",
    code: "TASK_ABORTED",
    instance: () =>
      new TaskAborted({
        message: "task stopped",
        details: { reason: "signal" },
        name: "AbortError",
      }),
    payload: {
      _tag: "TaskAborted",
      message: "task stopped",
      details: { reason: "signal" },
      name: "AbortError",
    },
  },
  {
    tag: "TaskTimeout",
    code: "TASK_TIMEOUT",
    instance: () =>
      new TaskTimeout({
        message: "task timed out",
        nodeId: "node-a",
        attempt: 2,
        timeoutMs: 1000,
      }),
    payload: {
      _tag: "TaskTimeout",
      message: "task timed out",
      nodeId: "node-a",
      attempt: 2,
      timeoutMs: 1000,
    },
  },
  {
    tag: "TaskHeartbeatTimeout",
    code: "TASK_HEARTBEAT_TIMEOUT",
    instance: () =>
      new TaskHeartbeatTimeout({
        message: "heartbeat stale",
        nodeId: "node-b",
        iteration: 3,
        attempt: 4,
        timeoutMs: 5000,
        staleForMs: 6000,
        lastHeartbeatAtMs: 12345,
      }),
    payload: {
      _tag: "TaskHeartbeatTimeout",
      message: "heartbeat stale",
      nodeId: "node-b",
      iteration: 3,
      attempt: 4,
      timeoutMs: 5000,
      staleForMs: 6000,
      lastHeartbeatAtMs: 12345,
    },
  },
  {
    tag: "RunNotFound",
    code: "RUN_NOT_FOUND",
    instance: () => new RunNotFound({ message: "missing run", runId: "run-1" }),
    payload: { _tag: "RunNotFound", message: "missing run", runId: "run-1" },
  },
  {
    tag: "InvalidInput",
    code: "INVALID_INPUT",
    instance: () =>
      new InvalidInput({ message: "bad input", details: { field: "name" } }),
    payload: {
      _tag: "InvalidInput",
      message: "bad input",
      details: { field: "name" },
    },
  },
  {
    tag: "DbWriteFailed",
    code: "DB_WRITE_FAILED",
    instance: () =>
      new DbWriteFailed({ message: "write failed", details: { table: "runs" } }),
    payload: {
      _tag: "DbWriteFailed",
      message: "write failed",
      details: { table: "runs" },
    },
  },
  {
    tag: "AgentCliError",
    code: "AGENT_CLI_ERROR",
    instance: () =>
      new AgentCliError({ message: "cli failed", details: { exitCode: 127 } }),
    payload: {
      _tag: "AgentCliError",
      message: "cli failed",
      details: { exitCode: 127 },
    },
  },
  {
    tag: "WorkflowFailed",
    code: "WORKFLOW_EXECUTION_FAILED",
    instance: () =>
      new WorkflowFailed({
        message: "workflow failed",
        details: { childRunId: "child-1" },
        status: 500,
      }),
    payload: {
      _tag: "WorkflowFailed",
      message: "workflow failed",
      details: { childRunId: "child-1" },
      status: 500,
    },
  },
];

describe("SmithersError", () => {
  test("includes the public error docs URL by default", () => {
    const error = new SmithersError("INVALID_INPUT", "Bad input");
    expect(error.message).toContain(ERROR_REFERENCE_URL);
    expect(error.summary).toBe("Bad input");
    expect(error.docsUrl).toBe(ERROR_REFERENCE_URL);
  });

  test("can omit docs URL from the message", () => {
    const error = new SmithersError("INVALID_INPUT", "Bad input", undefined, {
      includeDocsUrl: false,
    });
    expect(error.message).toBe("Bad input");
    expect(error.docsUrl).toBe(ERROR_REFERENCE_URL);
  });

  test("does not duplicate docs URL if summary already contains it", () => {
    const error = new SmithersError(
      "INVALID_INPUT",
      `Bad input See ${ERROR_REFERENCE_URL}`,
    );
    expect(error.message.match(/https:\/\/smithers\.sh\/reference\/errors/g))
      .toHaveLength(1);
  });

  test("supports legacy cause argument", () => {
    const cause = new Error("root cause");
    const error = new SmithersError("INTERNAL_ERROR", "Wrapped", undefined, cause);
    expect(error.cause).toBe(cause);
  });

  test("supports options object cause and custom name", () => {
    const cause = { why: "test" };
    const error = new SmithersError("RUN_NOT_FOUND", "Missing", undefined, {
      cause,
      name: "CustomSmithersError",
    });
    expect(error.name).toBe("CustomSmithersError");
    expect(error.cause).toBe(cause);
  });

  test("preserves details without cloning", () => {
    const details = { runId: "r1" };
    const error = new SmithersError("RUN_NOT_FOUND", "Missing", details);
    expect(error.details).toBe(details);
  });

  test("has a working Error prototype chain", () => {
    const error = new SmithersError("INVALID_INPUT", "Bad input");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SmithersError);
  });

  test("isSmithersError accepts genuine SmithersErrors", () => {
    expect(isSmithersError(new SmithersError("INVALID_INPUT", "Bad input"))).toBe(true);
    expect(isSmithersError({ code: "INVALID_INPUT", message: "Y" })).toBe(true);
    expect(isSmithersError(new Error("plain"))).toBe(false);
  });

  test("isSmithersError rejects foreign errors and arbitrary objects", () => {
    expect(isSmithersError({ code: "X", message: "Y" })).toBe(false);
    expect(isSmithersError({ code: "ENOENT", message: "no such file" })).toBe(false);
    expect(isSmithersError(Object.assign(new Error("fs"), { code: "ENOENT" }))).toBe(false);
  });
});

describe("error code catalog", () => {
  test("knownSmithersErrorCodes matches smithersErrorDefinitions keys", () => {
    expect([...knownSmithersErrorCodes].sort()).toEqual(
      Object.keys(smithersErrorDefinitions).sort(),
    );
  });

  test("knownSmithersErrorCodes has no duplicates", () => {
    expect(new Set(knownSmithersErrorCodes).size).toBe(knownSmithersErrorCodes.length);
  });

  test("every known definition has category and when text", () => {
    for (const code of knownSmithersErrorCodes) {
      const definition = getSmithersErrorDefinition(code);
      expect(typeof definition?.category).toBe("string");
      expect(definition?.category.length).toBeGreaterThan(0);
      expect(typeof definition?.when).toBe("string");
      expect(definition?.when.length).toBeGreaterThan(0);
    }
  });

  test("recognizes real known codes", () => {
    expect(isKnownSmithersErrorCode("INVALID_INPUT")).toBe(true);
    expect(isKnownSmithersErrorCode("RUN_NOT_FOUND")).toBe(true);
  });

  test("rejects unknown codes", () => {
    expect(isKnownSmithersErrorCode("NOT_A_CODE")).toBe(false);
  });

  test("rejects inherited object keys as known codes", () => {
    expect(isKnownSmithersErrorCode("toString")).toBe(false);
    expect(getSmithersErrorDefinition("toString")).toBeUndefined();
  });

  test("docs URL is stable for known and unknown codes", () => {
    expect(getSmithersErrorDocsUrl("INVALID_INPUT")).toBe(ERROR_REFERENCE_URL);
    expect(getSmithersErrorDocsUrl("NOT_A_CODE")).toBe(ERROR_REFERENCE_URL);
  });
});

describe("tagged error payload conversion", () => {
  for (const entry of taggedCases) {
    test(`${entry.tag} is recognized and serializes to a durable payload`, () => {
      const error = entry.instance();
      expect(isSmithersTaggedErrorTag(entry.tag)).toBe(true);
      expect(isSmithersTaggedError(error)).toBe(true);
      expect(toTaggedErrorPayload(error)).toEqual(entry.payload);
      expect(smithersTaggedErrorCodes[entry.tag]).toBe(entry.code);
    });

    test(`${entry.tag} payload round-trips back to the tagged error shape`, () => {
      const roundTripped = fromTaggedErrorPayload(entry.payload);
      for (const [key, value] of Object.entries(entry.payload)) {
        expect(roundTripped[key]).toEqual(value);
      }
    });
  }

  test("unknown values do not serialize as tagged payloads", () => {
    expect(toTaggedErrorPayload(null)).toBeUndefined();
    expect(toTaggedErrorPayload(new Error("plain"))).toBeUndefined();
    expect(toTaggedErrorPayload({ _tag: "Unknown", message: "x" })).toBeUndefined();
  });

  test("unknown tag is rejected by the tag guard", () => {
    expect(isSmithersTaggedErrorTag("Unknown")).toBe(false);
  });

  test("inherited keys are rejected by the tag guard", () => {
    expect(isSmithersTaggedErrorTag("toString")).toBe(false);
  });

  test("non-object details are omitted from generic payloads", () => {
    const error = new InvalidInput({ message: "bad", details: ["not", "record"] });
    expect(toTaggedErrorPayload(error)).toEqual({
      _tag: "InvalidInput",
      message: "bad",
      details: undefined,
    });
  });

  test("unknown payload tag returns undefined at runtime", () => {
    expect(fromTaggedErrorPayload({ _tag: "Unknown", message: "x" })).toBeUndefined();
  });
});

describe("fromTaggedError", () => {
  for (const entry of taggedCases) {
    test(`${entry.tag} normalizes to SmithersError code ${entry.code}`, () => {
      const normalized = fromTaggedError(entry.instance());
      expect(normalized).toBeInstanceOf(SmithersError);
      expect(normalized?.code).toBe(entry.code);
      expect(normalized?.summary).toBe(entry.payload.message);
    });
  }

  test("returns undefined for non-tagged values", () => {
    expect(fromTaggedError(null)).toBeUndefined();
    expect(fromTaggedError(new Error("plain"))).toBeUndefined();
  });

  test("uses tag as fallback summary when message is missing", () => {
    const normalized = fromTaggedError({ _tag: "RunNotFound", runId: "r1" });
    expect(normalized?.summary).toBe("RunNotFound");
    expect(normalized?.details).toEqual({ runId: "r1" });
  });

  test("ignores array details", () => {
    const normalized = fromTaggedError({
      _tag: "InvalidInput",
      message: "bad",
      details: ["field"],
    });
    expect(normalized?.details).toBeUndefined();
  });

  test("preserves cause from tagged objects", () => {
    const cause = new Error("root");
    const normalized = fromTaggedError({
      _tag: "DbWriteFailed",
      message: "write failed",
      details: { table: "runs" },
      cause,
    });
    expect(normalized?.cause).toBe(cause);
  });
});

describe("toSmithersError", () => {
  test("returns the same SmithersError when no wrapping is requested", () => {
    const original = new SmithersError("INVALID_INPUT", "Bad input");
    expect(toSmithersError(original)).toBe(original);
  });

  test("wraps SmithersError with label and operation detail", () => {
    const original = new SmithersError("INVALID_INPUT", "Bad input", {
      field: "name",
    });
    const wrapped = toSmithersError(original, "validate");
    expect(wrapped).not.toBe(original);
    expect(wrapped.code).toBe("INVALID_INPUT");
    expect(wrapped.summary).toBe("validate: Bad input");
    expect(wrapped.details).toEqual({ field: "name", operation: "validate" });
    expect(wrapped.cause).toBe(original);
  });

  test("normalizes EngineError code and context", () => {
    const cause = new EngineError({
      code: "SCHEDULER_ERROR",
      message: "bad state",
      context: { phase: "decide" },
    });
    const wrapped = toSmithersError(cause, "schedule");
    expect(wrapped.code).toBe("SCHEDULER_ERROR");
    expect(wrapped.details).toEqual({ phase: "decide", operation: "schedule" });
  });

  test("plain Error becomes INTERNAL_ERROR", () => {
    const cause = new Error("boom");
    const wrapped = toSmithersError(cause);
    expect(wrapped.code).toBe("INTERNAL_ERROR");
    expect(wrapped.summary).toBe("boom");
    expect(wrapped.cause).toBe(cause);
  });

  test("wraps Node-style error objects instead of returning them unwrapped", () => {
    // Regression: a Node system error like { code: "ENOENT", message } must not
    // be mistaken for a SmithersError. It should be wrapped, not returned as-is,
    // and the foreign libuv code must not leak into the SmithersError code.
    const foreign = { code: "ENOENT", message: "no such file" };
    const wrapped = toSmithersError(foreign);
    expect(wrapped).not.toBe(foreign);
    expect(wrapped).toBeInstanceOf(SmithersError);
    expect(wrapped.code).toBe("INTERNAL_ERROR");
    expect(isKnownSmithersErrorCode(wrapped.code)).toBe(true);
    expect(wrapped.cause).toBe(foreign);
  });

  test("wraps Node Error instances carrying an errno code", () => {
    const foreign = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const wrapped = toSmithersError(foreign, "connect");
    expect(wrapped).not.toBe(foreign);
    expect(wrapped).toBeInstanceOf(SmithersError);
    expect(wrapped.code).toBe("INTERNAL_ERROR");
    expect(isKnownSmithersErrorCode(wrapped.code)).toBe(true);
    expect(wrapped.summary).toBe("connect: connect ECONNREFUSED");
    expect(wrapped.cause).toBe(foreign);
  });

  test("primitive causes are stringified", () => {
    const wrapped = toSmithersError(404);
    expect(wrapped.code).toBe("INTERNAL_ERROR");
    expect(wrapped.summary).toBe("404");
  });

  test("options code overrides normalized code", () => {
    const wrapped = toSmithersError(new Error("bad"), undefined, {
      code: "INVALID_INPUT",
    });
    expect(wrapped.code).toBe("INVALID_INPUT");
  });

  test("options details override label operation only when provided", () => {
    const wrapped = toSmithersError(new Error("bad"), "upload", {
      details: { operation: "custom", file: "a.txt" },
    });
    expect(wrapped.details).toEqual({ operation: "custom", file: "a.txt" });
  });

  test("tagged errors normalize before wrapping", () => {
    const wrapped = toSmithersError(
      new TaskTimeout({
        message: "slow",
        nodeId: "n1",
        attempt: 1,
        timeoutMs: 100,
      }),
    );
    expect(wrapped.code).toBe("TASK_TIMEOUT");
    expect(wrapped.details).toEqual({ nodeId: "n1", attempt: 1, timeoutMs: 100 });
  });
});

describe("errorToJson", () => {
  test("serializes SmithersError fields", () => {
    const error = new SmithersError("RUN_NOT_FOUND", "Missing", { runId: "r1" });
    const json = errorToJson(error);
    expect(json.code).toBe("RUN_NOT_FOUND");
    expect(json.summary).toBe("Missing");
    expect(json.docsUrl).toBe(ERROR_REFERENCE_URL);
    expect(json.details).toEqual({ runId: "r1" });
  });

  test("serializes plain Error fields", () => {
    const json = errorToJson(new TypeError("bad type"));
    expect(json.name).toBe("TypeError");
    expect(json.message).toBe("bad type");
    expect(typeof json.stack).toBe("string");
  });

  test("serializes primitive values as message strings", () => {
    expect(errorToJson(null)).toEqual({ message: "null" });
    expect(errorToJson(undefined)).toEqual({ message: "undefined" });
  });

  test("returns non-Error objects unchanged", () => {
    const object = { custom: true };
    expect(errorToJson(object)).toBe(object);
  });

  test("serializes tagged errors through SmithersError shape", () => {
    const json = errorToJson(new RunNotFound({ message: "missing", runId: "r1" }));
    expect(json.code).toBe("RUN_NOT_FOUND");
    expect(json.details).toEqual({ runId: "r1" });
  });
});
