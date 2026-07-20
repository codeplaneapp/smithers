import { describe, expect, test } from "bun:test";
import * as barrel from "../src/index.js";
import { WorkflowDriver } from "../src/WorkflowDriver.js";
import { SmithersCtx } from "../src/SmithersCtx.js";

describe("driver barrel (index.js)", () => {
  test("re-exports WorkflowDriver and SmithersCtx", () => {
    expect(barrel.WorkflowDriver).toBe(WorkflowDriver);
    expect(barrel.SmithersCtx).toBe(SmithersCtx);
  });
});
