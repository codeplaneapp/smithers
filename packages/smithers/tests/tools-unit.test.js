import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  getToolContext,
  getToolIdempotencyKey,
  nextToolSeq,
  runWithToolContext,
} from "../src/tools/context.js";
import {
  defineTool,
  getDefinedToolMetadata,
} from "../src/tools/defineTool.js";
import { bashTool } from "../src/tools/bash.js";
import { editFileTool } from "../src/tools/edit.js";
import { grepTool } from "../src/tools/grep.js";
import { readFileTool } from "../src/tools/read.js";
import {
  captureProcess,
  canonicalRoot,
  getToolRuntimeOptions,
  sha256Hex,
  truncateToBytes,
} from "../src/tools/utils.js";
import { writeFileTool } from "../src/tools/write.js";

let tempDirs = [];

async function makeRoot() {
  const dir = await mkdtemp(join(tmpdir(), "smithers-tools-"));
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
    maxOutputBytes: 1024,
    timeoutMs: 1000,
    ...overrides,
  };
}

async function withToolCtx(rootDir, overrides, fn) {
  return runWithToolContext(baseCtx(rootDir, overrides), fn);
}

async function expectSmithersCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected SmithersError ${code}`);
}

async function withPlatform(platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

async function withBunWhich(implementation, fn) {
  const original = globalThis.Bun?.which;
  if (!globalThis.Bun) {
    globalThis.Bun = {};
  }
  globalThis.Bun.which = implementation;
  try {
    return await fn();
  } finally {
    if (original) {
      globalThis.Bun.which = original;
    } else {
      delete globalThis.Bun.which;
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tool context and definition helpers", () => {
  test("derives runtime defaults and idempotency keys from async context", async () => {
    const root = await makeRoot();

    expect(getToolContext()).toBeUndefined();
    expect(getToolRuntimeOptions().allowNetwork).toBe(false);
    expect(getToolIdempotencyKey()).toBeNull();
    expect(getToolIdempotencyKey({ runId: "r", nodeId: "n", iteration: 3 })).toBe(
      "smithers:r:n:3",
    );
    expect(getToolIdempotencyKey({ idempotencyKey: "custom" })).toBe("custom");
    expect(getToolIdempotencyKey({ runId: "r" })).toBeNull();

    const ctx = baseCtx(root, { allowNetwork: false, maxOutputBytes: 25 });
    await runWithToolContext(ctx, async () => {
      expect(getToolContext()).toBe(ctx);
      expect(getToolRuntimeOptions()).toMatchObject({
        rootDir: root,
        allowNetwork: false,
        maxOutputBytes: 25,
        timeoutMs: 1000,
      });
      expect(nextToolSeq(ctx)).toBe(1);
      expect(nextToolSeq(ctx)).toBe(2);
    });
  });

  test("wraps AI tools with Smithers metadata and execution context", async () => {
    const root = await makeRoot();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const repeatedWarningName = `mutating-${Date.now()}`;
    const missingCtxTool = defineTool({
      name: repeatedWarningName,
      schema: z.object({}),
      sideEffect: true,
      idempotent: false,
      execute: async () => "ok",
    });
    defineTool({
      name: repeatedWarningName,
      schema: z.object({}),
      sideEffect: true,
      idempotent: false,
      execute: async () => "ok",
    });
    expect(getDefinedToolMetadata(missingCtxTool)).toMatchObject({
      sideEffect: true,
      idempotent: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    const seen = [];
    const tool = defineTool({
      name: "echo-context",
      description: "Echo context",
      schema: z.object({ value: z.string() }),
      execute: async (args, ctx) => {
        seen.push(ctx);
        return `${args.value}:${ctx.idempotencyKey}:${ctx.toolName}`;
      },
    });

    const output = await withToolCtx(root, {}, () =>
      tool.execute({ value: "hello" }),
    );

    expect(output).toBe("hello:smithers:run-1:node-1:2:echo-context");
    expect(seen[0]).toMatchObject({
      toolName: "echo-context",
      sideEffect: false,
      idempotent: true,
    });

    const defaultContextTool = defineTool({
      name: "default-context",
      schema: z.object({}),
      execute: async (_args, ctx) => ctx,
    });
    const defaultContext = await defaultContextTool.execute({});
    expect(defaultContext).toMatchObject({
      rootDir: process.cwd(),
      allowNetwork: false,
      maxOutputBytes: 200_000,
      timeoutMs: 60_000,
      idempotencyKey: null,
      toolName: "default-context",
    });
    expect(getDefinedToolMetadata(null)).toBeNull();
  });
});

describe("file tools", () => {
  test("writes, reads, edits, and greps files inside the tool root", async () => {
    const root = await makeRoot();

    await withToolCtx(root, {}, async () => {
      expect(await writeFileTool("nested/file.txt", "alpha\nbeta\n")).toBe("ok");
      expect(readFileSync(join(root, "nested/file.txt"), "utf8")).toBe(
        "alpha\nbeta\n",
      );
      expect(await readFileTool("nested/file.txt")).toBe("alpha\nbeta\n");

      const patch = [
        "--- a/nested/file.txt",
        "+++ b/nested/file.txt",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        "+needle",
        "",
      ].join("\n");
      expect(await editFileTool("nested/file.txt", patch)).toBe("ok");
      expect(readFileSync(join(root, "nested/file.txt"), "utf8")).toContain(
        "needle",
      );
      expect(await grepTool("needle", "nested")).toContain("file.txt");
      expect(await grepTool("not-present", "nested")).toBe("");
    });
  });

  test("rejects oversized content, files, patches, and bad patches", async () => {
    const root = await makeRoot();
    writeFileSync(join(root, "large.txt"), "abcdef", "utf8");
    writeFileSync(join(root, "target.txt"), "one\ntwo\n", "utf8");

    await withToolCtx(root, { maxOutputBytes: 4 }, async () => {
      await expectSmithersCode(
        writeFileTool("too-large.txt", "abcde"),
        "TOOL_CONTENT_TOO_LARGE",
      );
      await expectSmithersCode(
        readFileTool("large.txt"),
        "TOOL_FILE_TOO_LARGE",
      );
      await expectSmithersCode(
        editFileTool("target.txt", "abcdef"),
        "TOOL_PATCH_TOO_LARGE",
      );
    });

    await withToolCtx(root, { maxOutputBytes: 1000 }, async () => {
      await expectSmithersCode(
        editFileTool(
          "target.txt",
          "--- a/target.txt\n+++ b/target.txt\n@@ -10,1 +10,1 @@\n-missing\n+nope\n",
        ),
        "TOOL_PATCH_FAILED",
      );
      await expectSmithersCode(grepTool("[", "."), "TOOL_GREP_FAILED");
    });
  });
});

describe("process helpers and bash tool", () => {
  test("hashes, canonicalizes, truncates, and captures process output", async () => {
    const root = await makeRoot();
    expect(sha256Hex("abc")).toHaveLength(64);
    expect(await canonicalRoot(root)).toBe(realpathSync(root));
    expect(truncateToBytes("abcdef", 3)).toBe("abc");
    expect(truncateToBytes("abc", 3)).toBe("abc");

    const result = await captureProcess(
      process.execPath,
      ["-e", "process.stdout.write('abcdef')"],
      { cwd: root, maxOutputBytes: 3, timeoutMs: 1000 },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "abc",
      stderr: "",
      truncated: true,
      totalBytes: 6,
    });

    const splitOutput = await captureProcess(
      process.execPath,
      ["-e", "process.stdout.write('abc'); process.stderr.write('def')"],
      { cwd: root, maxOutputBytes: 3, timeoutMs: 1000 },
    );
    // stdout and stderr each get their own 3-byte budget, so both fit
    // exactly and nothing is dropped.
    expect(splitOutput.stdout).toBe("abc");
    expect(splitOutput.stderr).toBe("def");
    expect(splitOutput.truncated).toBe(false);
    expect(splitOutput.totalBytes).toBe(6);

    await expectSmithersCode(
      captureProcess("/definitely/missing-smithers-command", [], {
        cwd: root,
        timeoutMs: 100,
      }),
      "PROCESS_FAILED",
    );
    await expectSmithersCode(
      captureProcess(
        process.execPath,
        ["-e", "setTimeout(() => {}, 10_000)"],
        { cwd: root, timeoutMs: 20 },
      ),
      "PROCESS_TIMEOUT",
    );
    await expectSmithersCode(
      captureProcess(
        process.execPath,
        ["-e", "setTimeout(() => {}, 10_000)"],
        { cwd: root, detached: true, timeoutMs: 20 },
      ),
      "PROCESS_TIMEOUT",
    );

    const originalKill = process.kill;
    process.kill = () => {
      throw new Error("group kill unavailable");
    };
    try {
      await expectSmithersCode(
        captureProcess(
          process.execPath,
          ["-e", "setTimeout(() => {}, 10_000)"],
          { cwd: root, detached: true, timeoutMs: 20 },
        ),
        "PROCESS_TIMEOUT",
      );
    } finally {
      process.kill = originalKill;
    }
  });

  test("gives stdout and stderr independent byte budgets", async () => {
    const root = await makeRoot();

    // Noisy stderr (well over the limit) must not steal budget from a real
    // stdout payload that fits comfortably under the limit. With a shared
    // budget, the stderr flood would truncate or drop the stdout output.
    const result = await captureProcess(
      process.execPath,
      [
        "-e",
        "process.stderr.write('e'.repeat(50)); process.stdout.write('keep-me')",
      ],
      { cwd: root, maxOutputBytes: 10, timeoutMs: 1000 },
    );

    expect(result.stdout).toBe("keep-me");
    expect(result.stderr).toBe("e".repeat(10));
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(57);
  });

  test("truncateToBytes never emits a replacement char mid-codepoint", async () => {
    // U+1F600 (grinning face) encodes to 4 UTF-8 bytes.
    const emoji = "\u{1F600}";
    expect(Buffer.byteLength(emoji, "utf8")).toBe(4);

    const text = `ab${emoji}cd`;
    // Cutting at 3 bytes lands in the middle of the emoji's 4-byte sequence.
    for (let maxBytes = 2; maxBytes <= 5; maxBytes += 1) {
      const truncated = truncateToBytes(text, maxBytes);
      expect(truncated).not.toContain("�");
    }
    // The partial emoji is dropped entirely rather than corrupted.
    expect(truncateToBytes(text, 4)).toBe("ab");
    expect(truncateToBytes(text, 5)).toBe("ab");
    // A complete emoji is kept once enough bytes are available.
    expect(truncateToBytes(text, 6)).toBe(`ab${emoji}`);

    // CJK characters encode to 3 UTF-8 bytes each; a mid-character cut must
    // not produce a replacement char either.
    const cjk = "你好"; // 你好
    expect(Buffer.byteLength(cjk, "utf8")).toBe(6);
    expect(truncateToBytes(cjk, 4)).toBe("你");
    expect(truncateToBytes(cjk, 4)).not.toContain("�");
  });

  test("captured output is not corrupted by a mid-codepoint byte limit", async () => {
    const root = await makeRoot();

    // Emit several multibyte codepoints, then cap the budget at a byte count
    // that necessarily lands inside one of them.
    const result = await captureProcess(
      process.execPath,
      ["-e", "process.stdout.write('\\u{1F600}\\u{1F600}\\u{1F600}')"],
      { cwd: root, maxOutputBytes: 6, timeoutMs: 1000 },
    );

    expect(result.stdout).not.toContain("�");
    // 6 bytes holds exactly the first emoji (4 bytes); the partial second one
    // is dropped instead of corrupted.
    expect(result.stdout).toBe("\u{1F600}");
    expect(result.truncated).toBe(true);
  });

  test("executes commands and reports command failures", async () => {
    const root = await makeRoot();

    await withToolCtx(root, { maxOutputBytes: 1000 }, async () => {
      const output = await bashTool(process.execPath, [
        "-e",
        "process.stdout.write(process.cwd().includes('smithers-tools-') ? 'cwd-ok' : 'bad')",
      ]);
      expect(output).toBe("cwd-ok");

      const error = await expectSmithersCode(
        bashTool(process.execPath, [
          "-e",
          "process.stdout.write('before-fail'); process.exit(7)",
        ]),
        "TOOL_COMMAND_FAILED",
      );
      expect(error.details.output).toContain("before-fail");
    });
  });

  test("validates bash input and network restrictions before spawning", async () => {
    const root = await makeRoot();

    await withToolCtx(root, {}, async () => {
      await expectSmithersCode(bashTool("", []), "INVALID_INPUT");
      await expectSmithersCode(bashTool(1, []), "INVALID_INPUT");
      await expectSmithersCode(bashTool("echo", "nope"), "INVALID_INPUT");
      await expectSmithersCode(
        bashTool("echo", Array.from({ length: 129 }, () => "x")),
        "INVALID_INPUT",
      );
      await expectSmithersCode(bashTool("echo", [1]), "INVALID_INPUT");
      await expectSmithersCode(
        bashTool("echo", [String(1).repeat(8193)]),
        "INVALID_INPUT",
      );
      await expectSmithersCode(
        bashTool("echo", [], { cwd: "x".repeat(1025) }),
        "INVALID_INPUT",
      );
    });

    await withToolCtx(root, { maxOutputBytes: 0 }, async () => {
      await expectSmithersCode(bashTool("echo", ["ok"]), "INVALID_INPUT");
    });
    await withToolCtx(root, { maxOutputBytes: 11 * 1024 * 1024 }, async () => {
      await expectSmithersCode(bashTool("echo", ["ok"]), "INVALID_INPUT");
    });
    await withToolCtx(root, { timeoutMs: 0 }, async () => {
      await expectSmithersCode(bashTool("echo", ["ok"]), "INVALID_INPUT");
    });
    await withToolCtx(root, { timeoutMs: 60 * 60 * 1000 + 1 }, async () => {
      await expectSmithersCode(bashTool("echo", ["ok"]), "INVALID_INPUT");
    });
    await withToolCtx(root, { allowNetwork: false }, async () => {
      await expectSmithersCode(bashTool("curl", ["https://example.com"]), "TOOL_NETWORK_DISABLED");
      await expectSmithersCode(bashTool("git", ["fetch"]), "TOOL_GIT_REMOTE_DISABLED");
      expect((await bashTool("/bin/echo", ["safe"])).trim()).toBe("safe");
      expect((await bashTool("/bin/echo", ["git", "status"])).trim()).toBe(
        "git status",
      );
    });

    await withPlatform("darwin", () =>
      withBunWhich(() => null, () =>
        withToolCtx(root, { allowNetwork: false }, async () => {
          expect((await bashTool("/bin/echo", ["darwin-fallback"])).trim()).toBe(
            "darwin-fallback",
          );
        }),
      ),
    );
  });

  test("resolves an explicit working directory inside the root", async () => {
    const root = await makeRoot();
    mkdirSync(join(root, "subdir"));

    await withToolCtx(root, {}, async () => {
      const output = await bashTool(
        process.execPath,
        ["-e", "process.stdout.write(process.cwd().endsWith('subdir') ? 'subdir' : process.cwd())"],
        { cwd: "subdir" },
      );
      expect(output).toBe("subdir");
    });
  });
});
