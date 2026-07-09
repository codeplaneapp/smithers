import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CursorAgent } from "../src/CursorAgent.js";

const originalPath = process.env.PATH ?? "";

/**
 * @param {string} stdoutScript
 */
async function makeFakeCursor(stdoutScript) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-cursor-test-"));
  const binPath = join(dir, "cursor-agent");
  await writeFile(binPath, `#!/usr/bin/env node\n${stdoutScript}\n`, "utf8");
  await chmod(binPath, 0o755);
  return { dir, binPath };
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.CURSOR_ARGS_FILE;
});

describe("CursorAgent", () => {
  test("builds Cursor headless command arguments", async () => {
    const agent = new CursorAgent({
      apiKey: "cursor-key",
      header: ["X-Test: yes"],
      model: "composer-2",
      mode: "plan",
      force: true,
      autoReview: true,
      sandbox: "disabled",
      approveMcps: true,
      workspace: "/tmp/workspace",
      pluginDir: ["plugins/a"],
      continueSession: true,
      worktree: "smithers-worktree",
      worktreeBase: "main",
      skipWorktreeSetup: true,
      extraArgs: ["--custom", "value"],
    });

    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "Implement the change",
      systemPrompt: "System instructions",
      options: { resumeSession: "chat-123" },
    });

    expect(command.command).toBe("cursor-agent");
    expect(command.outputFormat).toBe("stream-json");
    expect(command.env).toEqual({ CURSOR_API_KEY: "cursor-key" });
    expect(command.args.slice(0, 4)).toEqual(["--print", "--output-format", "stream-json", "--stream-partial-output"]);
    expect(command.args).toContain("--trust");
    expect(command.args).toContain("--custom");
    expect(command.args).toContain("value");
    expect(command.args.slice(command.args.indexOf("--model"), command.args.indexOf("--model") + 2)).toEqual([
      "--model",
      "composer-2",
    ]);
    expect(command.args.slice(command.args.indexOf("--mode"), command.args.indexOf("--mode") + 2)).toEqual([
      "--mode",
      "plan",
    ]);
    expect(command.args.slice(command.args.indexOf("--workspace"), command.args.indexOf("--workspace") + 2)).toEqual([
      "--workspace",
      "/tmp/workspace",
    ]);
    expect(command.args.slice(command.args.indexOf("--resume"), command.args.indexOf("--resume") + 2)).toEqual([
      "--resume",
      "chat-123",
    ]);
    expect(command.args.slice(command.args.indexOf("--worktree"), command.args.indexOf("--worktree") + 2)).toEqual([
      "--worktree",
      "smithers-worktree",
    ]);
    expect(command.args.at(-2)).toBe("--");
    expect(command.args.at(-1)).toBe("System instructions\n\nImplement the change");
  });

  test("interprets Cursor stream JSON through a subprocess run", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-cursor-args-"));
    const argsFile = join(argsFileDir, "args.json");
    const fake = await makeFakeCursor(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.CURSOR_ARGS_FILE) fs.writeFileSync(process.env.CURSOR_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-session" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "thinking", subtype: "delta", text: "checking" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "tool_call",
  subtype: "started",
  tool_call_id: "tool-1",
  name: "readToolCall",
  args: { path: "README.md" }
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "Hello" }] },
  timestamp_ms: Date.now()
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "Hello world", usage: { total_tokens: 12 } }) + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.CURSOR_ARGS_FILE = argsFile;
      /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
      const events = [];
      const agent = new CursorAgent({
        env: { PATH: process.env.PATH, CURSOR_ARGS_FILE: argsFile },
        force: true,
      });

      const result = await agent.generate({
        prompt: "Say hello",
        rootDir: fake.dir,
        onEvent: (event) => events.push(event),
      });

      expect(result.text).toBe("Hello world");
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "action",
        "action",
        "action",
        "completed",
      ]);
      expect(events[0]).toMatchObject({
        type: "started",
        engine: "cursor",
        title: "Cursor",
        resume: "cursor-session",
      });
      expect(events[3]).toMatchObject({
        type: "action",
        engine: "cursor",
        entryType: "message",
        message: "Hello",
      });
      expect(events[4]).toMatchObject({
        type: "completed",
        engine: "cursor",
        ok: true,
        answer: "Hello world",
        resume: "cursor-session",
      });

      const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
      expect(capturedArgs).toContain("--print");
      expect(capturedArgs).toContain("--output-format");
      expect(capturedArgs).toContain("stream-json");
      expect(capturedArgs).toContain("--stream-partial-output");
      expect(capturedArgs).toContain("--force");
      expect(capturedArgs.at(-2)).toBe("--");
      expect(capturedArgs.at(-1)).toBe("Say hello");
      expect(capturedArgs.slice(capturedArgs.indexOf("--workspace"), capturedArgs.indexOf("--workspace") + 2)).toEqual([
        "--workspace",
        fake.dir,
      ]);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("reports stderr when Cursor exits before emitting a result", () => {
    const agent = new CursorAgent();
    const interpreter = agent.createOutputInterpreter();

    expect(interpreter.onStdoutLine?.("not json")).toEqual([]);
    expect(interpreter.onExit?.({ exitCode: 2, stderr: "auth failed\n" })).toEqual([
      {
        type: "started",
        engine: "cursor",
        title: "Cursor",
        resume: undefined,
        detail: undefined,
      },
      {
        type: "completed",
        engine: "cursor",
        ok: false,
        answer: undefined,
        error: "auth failed",
        resume: undefined,
      },
    ]);
    expect(interpreter.onExit?.({ exitCode: 2, stderr: "auth failed\n" })).toEqual([]);
  });

  test("accumulates Cursor partial assistant deltas when no result event is emitted", () => {
    const agent = new CursorAgent();
    const interpreter = agent.createOutputInterpreter();

    expect(interpreter.onStdoutLine?.(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello " }] },
      timestamp_ms: 1,
    }))).toHaveLength(2);
    expect(interpreter.onStdoutLine?.(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "world" }] },
      timestamp_ms: 2,
    }))).toHaveLength(1);

    expect(interpreter.onExit?.({ exitCode: 0 })).toEqual([
      {
        type: "completed",
        engine: "cursor",
        ok: true,
        answer: "Hello world",
        error: undefined,
        resume: undefined,
      },
    ]);
  });

  test("uses Cursor result text as the error message for error result events", () => {
    const agent = new CursorAgent();
    const interpreter = agent.createOutputInterpreter();

    expect(interpreter.onStdoutLine?.(JSON.stringify({
      type: "result",
      subtype: "error",
      result: "model unavailable",
      session_id: "cursor-session",
    }))).toEqual([
      {
        type: "started",
        engine: "cursor",
        title: "Cursor",
        resume: "cursor-session",
        detail: { sessionId: "cursor-session" },
      },
      {
        type: "completed",
        engine: "cursor",
        ok: false,
        answer: undefined,
        error: "model unavailable",
        resume: "cursor-session",
        usage: undefined,
      },
    ]);
  });
});
