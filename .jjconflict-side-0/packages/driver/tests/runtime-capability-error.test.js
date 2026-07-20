import { describe, expect, test } from "bun:test";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { RuntimeCapabilityError } from "../src/RuntimeCapabilityError.js";

describe("RuntimeCapabilityError", () => {
  test("is a typed SmithersError with the RUNTIME_CAPABILITY_UNAVAILABLE code", () => {
    const error = new RuntimeCapabilityError("browser", "filesystem", "readFile");
    expect(error).toBeInstanceOf(SmithersError);
    expect(error).toBeInstanceOf(RuntimeCapabilityError);
    expect(error.name).toBe("RuntimeCapabilityError");
    expect(error.code).toBe("RUNTIME_CAPABILITY_UNAVAILABLE");
  });

  test("carries runtime/capability/operation in details and as own fields", () => {
    const error = new RuntimeCapabilityError("browser", "subprocess", "spawn");
    expect(error.details).toEqual({
      runtime: "browser",
      capability: "subprocess",
      operation: "spawn",
    });
    expect(error.runtime).toBe("browser");
    expect(error.capability).toBe("subprocess");
    expect(error.operation).toBe("spawn");
  });

  test("message names the runtime, capability, and operation", () => {
    const error = new RuntimeCapabilityError("browser", "sandbox", "run");
    expect(error.message).toContain("browser");
    expect(error.message).toContain("sandbox");
    expect(error.message).toContain("run");
  });

  test("supports an optional cause", () => {
    const cause = new Error("original failure");
    const error = new RuntimeCapabilityError("browser", "worktree", "resolve", { cause });
    expect(error.cause).toBe(cause);
  });
});
