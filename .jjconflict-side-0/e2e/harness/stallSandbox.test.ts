import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "@smithers-orchestrator/sandbox/SandboxHandle";
import { stallSandbox } from "./stallSandbox.ts";

function makeHandle(): { handle: SandboxHandle; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "stall-sandbox-"));
  const sandboxRoot = join(root, "sandbox");
  const requestPath = join(sandboxRoot, "request");
  const resultPath = join(sandboxRoot, "result");
  mkdirSync(requestPath, { recursive: true });
  mkdirSync(resultPath, { recursive: true });
  writeFileSync(join(requestPath, "marker.txt"), "ok", "utf8");
  const handle: SandboxHandle = {
    runtime: "bubblewrap",
    runId: "run-stall-test",
    sandboxId: "sbx-stall-test",
    sandboxRoot,
    requestPath,
    resultPath,
  };
  return {
    handle,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("stallSandbox", () => {
  test("makes the request path inaccessible while stalled", async () => {
    const { handle, cleanup } = makeHandle();
    try {
      expect(existsSync(handle.requestPath)).toBe(true);
      const stall = await stallSandbox(handle, 5000);
      expect(existsSync(handle.requestPath)).toBe(false);
      expect(existsSync(`${handle.requestPath}.stalled`)).toBe(true);
      await stall.release();
      expect(existsSync(handle.requestPath)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("auto-release restores the request path after durationMs", async () => {
    const { handle, cleanup } = makeHandle();
    try {
      await stallSandbox(handle, 100);
      expect(existsSync(handle.requestPath)).toBe(false);
      await wait(250);
      expect(existsSync(handle.requestPath)).toBe(true);
      expect(existsSync(`${handle.requestPath}.stalled`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("manual release restores immediately and cancels auto-release", async () => {
    const { handle, cleanup } = makeHandle();
    try {
      const stall = await stallSandbox(handle, 5000);
      expect(existsSync(handle.requestPath)).toBe(false);
      await stall.release();
      expect(existsSync(handle.requestPath)).toBe(true);
      // release is idempotent and double-release does not throw
      await stall.release();
      expect(existsSync(handle.requestPath)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
