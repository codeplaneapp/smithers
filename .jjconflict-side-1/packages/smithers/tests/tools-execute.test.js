import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithToolContext } from "../src/tools/context.js";
import { bash, edit, grep, read, write } from "../src/tools/index.js";
import { tools } from "../src/tools/index.js";
import { warnNetworkIsolationUnenforced } from "../src/tools/bash.js";
import { captureProcess } from "../src/tools/utils.js";

let tempDirs = [];

async function makeRoot() {
  const dir = await mkdtemp(join(tmpdir(), "smithers-tools-exec-"));
  tempDirs.push(dir);
  return dir;
}

function baseCtx(rootDir, overrides = {}) {
  return {
    rootDir,
    runId: "run-1",
    nodeId: "node-1",
    iteration: 2,
    attempt: 1,
    allowNetwork: true,
    maxOutputBytes: 4096,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function withToolCtx(rootDir, overrides, fn) {
  return runWithToolContext(baseCtx(rootDir, overrides), fn);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("defined tool .execute() wrappers", () => {
  test("the exported ai-sdk tools run their execute path end to end", async () => {
    const root = await makeRoot();

    await withToolCtx(root, {}, async () => {
      // write -> read -> edit -> grep, each through the wrapped tool.execute()
      // (the arrow passed to defineTool), not the bare *Tool helper.
      expect(await write.execute({ path: "dir/file.txt", content: "alpha\nbeta\n" })).toBe("ok");
      expect(readFileSync(join(root, "dir/file.txt"), "utf8")).toBe("alpha\nbeta\n");

      expect(await read.execute({ path: "dir/file.txt" })).toBe("alpha\nbeta\n");

      const patch = [
        "--- a/dir/file.txt",
        "+++ b/dir/file.txt",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        "+needle",
        "",
      ].join("\n");
      expect(await edit.execute({ path: "dir/file.txt", patch })).toBe("ok");
      expect(readFileSync(join(root, "dir/file.txt"), "utf8")).toContain("needle");

      expect(await grep.execute({ pattern: "needle", path: "dir" })).toContain("file.txt");

      const bashOut = await bash.execute({
        cmd: process.execPath,
        args: ["-e", "process.stdout.write('bash-exec-ok')"],
      });
      expect(bashOut).toBe("bash-exec-ok");
    });
  });

  test("the tools registry exposes exactly the five file/process tools", () => {
    expect(Object.keys(tools).sort()).toEqual(["bash", "edit", "grep", "read", "write"]);
    expect(tools.bash).toBe(bash);
    expect(tools.read).toBe(read);
  });
});

describe("captureProcess byte budgeting across multiple chunks", () => {
  test("a second stdout chunk after the budget is exhausted is dropped, not stored", async () => {
    const root = await makeRoot();
    // Emit one chunk that already exceeds the byte budget, then (after a delay
    // so it lands as a distinct 'data' event) a second chunk. The second chunk
    // arrives when the remaining budget is already <= 0, exercising the
    // early-return drop branch in appendLimited.
    const result = await captureProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write('a'.repeat(100)); setTimeout(() => process.stdout.write('b'.repeat(100)), 40)",
      ],
      { cwd: root, maxOutputBytes: 10, timeoutMs: 5000 },
    );

    // Only the first 10 bytes are retained; the later chunk is fully dropped.
    expect(result.stdout).toBe("a".repeat(10));
    expect(result.stdout).not.toContain("b");
    expect(result.truncated).toBe(true);
    // totalBytes still accounts for every byte the process actually wrote.
    expect(result.totalBytes).toBe(200);
  });
});

describe("warnNetworkIsolationUnenforced never lets a logging failure escape", () => {
  test("the structured warning swallows a throwing logger instead of rejecting", async () => {
    // The Effect log pipeline writes through console.log; if that throws, the
    // warning must degrade to a no-op (the trailing .catch) rather than
    // surfacing a rejection into the bash tool's hot path.
    const origLog = console.log;
    console.log = () => {
      throw new Error("logger boom");
    };
    try {
      await expect(warnNetworkIsolationUnenforced()).resolves.toBeUndefined();
    } finally {
      console.log = origLog;
    }
  });
});
