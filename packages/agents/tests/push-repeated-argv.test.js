import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAgent } from "../src/CodexAgent.js";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";
import { CursorAgent } from "../src/CursorAgent.js";
import { KimiAgent } from "../src/KimiAgent.js";
import { pushRepeated } from "../src/BaseCliAgent/index.js";

/**
 * Count occurrences of an exact argv token.
 * @param {string[]} args
 * @param {string} flag
 */
function flagCount(args, flag) {
  return args.filter((arg) => arg === flag).length;
}

/**
 * Return the value immediately following each occurrence of `flag`.
 * @param {string[]} args
 * @param {string} flag
 */
function flagValues(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) values.push(args[i + 1]);
  }
  return values;
}

describe("pushRepeated", () => {
  test("emits one flag/value pair per entry", () => {
    const args = [];
    pushRepeated(args, "--add-dir", ["/a", "/b"]);
    expect(args).toEqual(["--add-dir", "/a", "--add-dir", "/b"]);
  });
  test("is a no-op for empty or missing values", () => {
    const args = ["x"];
    pushRepeated(args, "--add-dir", []);
    pushRepeated(args, "--add-dir", undefined);
    expect(args).toEqual(["x"]);
  });
});

describe("CodexAgent repeated flags (vendor: codex-cli 0.149.0, one value per occurrence)", () => {
  test("serializes each addDir as its own --add-dir pair", async () => {
    const agent = new CodexAgent({ addDir: ["/first", "/second"] });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      expect(flagValues(command.args, "--add-dir")).toEqual(["/first", "/second"]);
      expect(flagCount(command.args, "--add-dir")).toBe(2);
    } finally {
      await command.cleanup?.();
    }
  });
  test("serializes each enable/disable feature as its own flag pair", async () => {
    const agent = new CodexAgent({ enable: ["a", "b"], disable: ["x", "y"] });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      expect(flagValues(command.args, "--enable")).toEqual(["a", "b"]);
      expect(flagValues(command.args, "--disable")).toEqual(["x", "y"]);
    } finally {
      await command.cleanup?.();
    }
  });
  test("keeps --image variadic (vendor accepts <FILE>... per occurrence)", async () => {
    const agent = new CodexAgent({ image: ["/a.png", "/b.png"] });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      expect(flagCount(command.args, "--image")).toBe(1);
      expect(flagValues(command.args, "--image")).toEqual(["/a.png"]);
      const imageIndex = command.args.indexOf("--image");
      expect(command.args[imageIndex + 2]).toBe("/b.png");
    } finally {
      await command.cleanup?.();
    }
  });
  test("resume commands keep omitting addDir", async () => {
    const agent = new CodexAgent({ addDir: ["/first", "/second"] });
    const command = await agent.buildCommand({
      prompt: "hi",
      cwd: process.cwd(),
      options: { resumeSession: "thread-1" },
    });
    try {
      expect(command.args).not.toContain("--add-dir");
    } finally {
      await command.cleanup?.();
    }
  });
});

describe("ClaudeCodeAgent list flags (vendor: claude-code 2.1.241)", () => {
  test("serializes each pluginDir as its own --plugin-dir pair", async () => {
    const agent = new ClaudeCodeAgent({ pluginDir: ["/p1", "/p2"] });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      expect(flagValues(command.args, "--plugin-dir")).toEqual(["/p1", "/p2"]);
    } finally {
      await command.cleanup?.();
    }
  });
  test("keeps --add-dir variadic (vendor accepts <directories...>)", async () => {
    const agent = new ClaudeCodeAgent({ addDir: ["/a", "/b"] });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      expect(flagCount(command.args, "--add-dir")).toBe(1);
    } finally {
      await command.cleanup?.();
    }
  });
});

describe("CursorAgent repeated flags (vendor: cursor-agent 2026.08.11, accumulating single-value parser)", () => {
  test("serializes each pluginDir as its own --plugin-dir pair", async () => {
    const agent = new CursorAgent({ pluginDir: ["/p1", "/p2"] });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    expect(flagValues(command.args, "--plugin-dir")).toEqual(["/p1", "/p2"]);
  });
  test("serializes each header as its own --header pair", async () => {
    const agent = new CursorAgent({ header: ["A: 1", "B: 2"] });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    expect(flagValues(command.args, "--header")).toEqual(["A: 1", "B: 2"]);
  });
});

describe("KimiAgent repeated flags (vendor: kimi 1.48.0, one value per occurrence)", () => {
  test("serializes each mcpConfigFile/mcpConfig as its own flag pair", async () => {
    // Point KIMI_SHARE_DIR at an empty dir so ensureKimiCredentialsUsable is a
    // no-op regardless of the developer machine's own ~/.kimi credentials.
    const shareDir = await mkdtemp(join(tmpdir(), "smithers-kimi-share-"));
    const agent = new KimiAgent({
      configDir: shareDir,
      mcpConfigFile: ["/a.json", "/b.json"],
      mcpConfig: ['{"a":1}', '{"b":2}'],
    });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      expect(flagValues(command.args, "--mcp-config-file")).toEqual(["/a.json", "/b.json"]);
      expect(flagValues(command.args, "--mcp-config")).toEqual(['{"a":1}', '{"b":2}']);
    } finally {
      await command.cleanup?.();
    }
  });
});
