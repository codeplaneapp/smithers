import { describe, expect, test } from "bun:test";
import { SmithersError, isSmithersError, errorToJson } from "../src/utils/errors";

describe("SmithersError", () => {
  test("creates error with code and message", () => {
    const err = new SmithersError("AGENT_CLI_ERROR", "Something went wrong");
    expect(err.code).toBe("AGENT_CLI_ERROR");
    expect(err.message).toBe("Something went wrong");
    expect(err).toBeInstanceOf(Error);
  });

  test("creates error with details", () => {
    const err = new SmithersError("INVALID_INPUT", "Invalid", { field: "name" });
    expect(err.details).toEqual({ field: "name" });
  });

  test("error without details has undefined details", () => {
    const err = new SmithersError("MISSING_OUTPUT", "msg");
    expect(err.details).toBeUndefined();
  });
});

describe("isSmithersError", () => {
  test("returns true for SmithersError", () => {
    const err = new SmithersError("MISSING_OUTPUT", "msg");
    expect(isSmithersError(err)).toBe(true);
  });

  test("returns true for object with code property", () => {
    expect(isSmithersError({ code: "ERR", message: "msg" })).toBe(true);
  });

  test("returns false for plain Error", () => {
    expect(isSmithersError(new Error("msg"))).toBe(false);
  });

  test("returns false for null", () => {
    expect(isSmithersError(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isSmithersError(undefined)).toBe(false);
  });

  test("returns false for string", () => {
    expect(isSmithersError("error")).toBe(false);
  });
});

describe("errorToJson", () => {
  test("serializes Error instance", () => {
    const err = new Error("test error");
    const json = errorToJson(err);
    expect(json.name).toBe("Error");
    expect(json.message).toBe("test error");
    expect(json.stack).toBeDefined();
  });

  test("serializes SmithersError with code and details", () => {
    const err = new SmithersError("AGENT_CLI_ERROR", "task failed", {
      nodeId: "t1",
    });
    const json = errorToJson(err);
    expect(json.name).toBe("Error");
    expect(json.message).toBe("task failed");
    expect(json.code).toBe("AGENT_CLI_ERROR");
    expect(json.details).toEqual({ nodeId: "t1" });
  });

  test("serializes plain object", () => {
    const obj = { type: "error", reason: "unknown" };
    const json = errorToJson(obj);
    expect(json).toEqual(obj);
  });

  test("serializes string", () => {
    const json = errorToJson("something broke");
    expect(json).toEqual({ message: "something broke" });
  });

  test("serializes number", () => {
    const json = errorToJson(42);
    expect(json).toEqual({ message: "42" });
  });

  test("serializes null", () => {
    const json = errorToJson(null);
    expect(json).toEqual({ message: "null" });
  });

  test("serializes undefined", () => {
    const json = errorToJson(undefined);
    expect(json).toEqual({ message: "undefined" });
  });

  test("preserves cause on Error", () => {
    const cause = new Error("root cause");
    const err = new Error("wrapper", { cause });
    const json = errorToJson(err);
    expect(json.cause).toBe(cause);
  });
});
