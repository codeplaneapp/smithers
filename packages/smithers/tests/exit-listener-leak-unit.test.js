import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createExternalSmithers } from "../src/external/create-external-smithers.js";

let tempDirs = [];

function makeDbPath(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, "smithers.db");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createExternalSmithers exit-listener cleanup", () => {
  // Regression: createExternalSmithers registered process.on("exit", closeDb)
  // without ever removing it, so constructing/closing many instances (tests,
  // gateway, hot reload) leaked one "exit" listener each, eventually tripping
  // MaxListenersExceededWarning and retaining sqlite handles. The fix registers
  // with process.once and removes the listener inside closeDb, so cleanup() must
  // return the "exit" listener count to its baseline.
  test("does not accumulate process exit listeners across create+cleanup cycles", () => {
    const baseline = process.listenerCount("exit");

    for (let i = 0; i < 25; i++) {
      const workflow = createExternalSmithers({
        dbPath: makeDbPath("smithers-exit-leak-"),
        schemas: { result: z.object({ ok: z.boolean() }) },
        agents: {},
        buildFn: () => ({ kind: "text", text: "noop" }),
      });
      // While alive, exactly one extra listener should be registered.
      expect(process.listenerCount("exit")).toBe(baseline + 1);
      workflow.cleanup();
      // After cleanup, the listener it registered must be detached.
      expect(process.listenerCount("exit")).toBe(baseline);
    }

    // Net result: no leaked listeners regardless of how many were created.
    expect(process.listenerCount("exit")).toBe(baseline);
  });
});
