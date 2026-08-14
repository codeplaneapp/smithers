import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { bundleGatewayUiEntry } from "../src/gatewayUi/bundle.js";

/**
 * Failure-path coverage for the gateway UI bundler: the "Bun.build missing"
 * guard and the `!result.success` branch that surfaces Bun.build's logs.
 *
 * Bun.build is a writable global method, so these swap in a stand-in for the
 * specific failure shape (Bun.build's documented `{ success, logs }` result) and
 * restore it — the code under test is bundle.js's own error handling, not
 * Bun.build itself.
 */
describe("bundleGatewayUiEntry failure paths", () => {
  let tempDir;
  let originalBuild;

  afterEach(() => {
    if (originalBuild !== undefined) {
      Bun.build = originalBuild;
      originalBuild = undefined;
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test("throws INVALID_INPUT when Bun.build is unavailable", async () => {
    originalBuild = Bun.build;
    // Simulate a non-Bun / older runtime where Bun.build is not a function.
    Bun.build = undefined;
    await expect(bundleGatewayUiEntry({ entry: "/nope/entry.tsx" }, new Map())).rejects.toThrow(
      "Gateway UI bundling requires Bun.build.",
    );
  });

  test("throws INVALID_INPUT built from the build logs when the entry fails to build", async () => {
    originalBuild = Bun.build;
    Bun.build = async () => ({
      success: false,
      logs: [{ message: "first log line" }, { message: "" }, { message: "second log line" }],
    });
    let caught;
    try {
      await bundleGatewayUiEntry({ entry: "/whatever/entry.tsx" }, new Map());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("INVALID_INPUT");
    // Message is built from the non-empty log messages joined by newline (the
    // empty-message entry is filtered out); SmithersError appends a docs link.
    expect(caught.message).toContain("first log line\nsecond log line");
  });

  test("falls back to a generic message when a failed build reports no logs", async () => {
    originalBuild = Bun.build;
    Bun.build = async () => ({ success: false, logs: [] });
    await expect(bundleGatewayUiEntry({ entry: "/some/entry.tsx" }, new Map())).rejects.toThrow(
      "Failed to build Gateway UI entry /some/entry.tsx",
    );
  });

  test("restores a working Bun.build after the stubs", () => {
    expect(typeof Bun.build).toBe("function");
  });
});
