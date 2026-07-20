import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VibeAgent } from "../src/VibeAgent.js";

const originalPath = process.env.PATH ?? "";

/**
 * @param {string} stdoutScript
 */
async function makeFakeVibe(stdoutScript) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-vibe-test-"));
  const binPath = join(dir, "vibe");
  const script = `#!/usr/bin/env node\n${stdoutScript}\n`;
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  return { dir, binPath };
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.VIBE_ARGS_FILE;
});

describe("VibeAgent", () => {
  test("builds Vibe command arguments for streamed execution", async () => {
    const agent = new VibeAgent({
      agent: "auto-approve",
      maxTurns: 2,
      maxPrice: 1.5,
      maxTokens: 4096,
      enabledTools: ["Read", "Bash"],
      sessionId: "configured-session",
      continueSession: true,
      extraArgs: ["--custom", "value"],
    });

    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "Implement the change",
      systemPrompt: "System instructions",
      options: { resumeSession: "runtime-session" },
    });

    expect(command.command).toBe("vibe");
    expect(command.outputFormat).toBe("stream-json");
    expect(command.args).toContain("--trust");
    expect(command.args).toContain("--output");
    expect(command.args).toContain("streaming");
    expect(command.args).toContain("--custom");
    expect(command.args).toContain("value");
    expect(command.args).not.toContain("-c");
    expect(agent.issuedSessionId).toBe("runtime-session");
    expect(command.args.slice(command.args.indexOf("--resume"), command.args.indexOf("--resume") + 2)).toEqual([
      "--resume",
      "runtime-session",
    ]);
    expect(command.args.slice(command.args.indexOf("--agent"), command.args.indexOf("--agent") + 2)).toEqual([
      "--agent",
      "auto-approve",
    ]);
    expect(command.args.slice(command.args.indexOf("--max-turns"), command.args.indexOf("--max-turns") + 2)).toEqual([
      "--max-turns",
      "2",
    ]);
    expect(command.args.slice(command.args.indexOf("--max-price"), command.args.indexOf("--max-price") + 2)).toEqual([
      "--max-price",
      "1.5",
    ]);
    expect(command.args.slice(command.args.indexOf("--max-tokens"), command.args.indexOf("--max-tokens") + 2)).toEqual([
      "--max-tokens",
      "4096",
    ]);
    expect(command.args.slice(command.args.indexOf("--workdir"), command.args.indexOf("--workdir") + 2)).toEqual([
      "--workdir",
      "/tmp/project",
    ]);
    expect(command.args.slice(command.args.indexOf("--prompt"), command.args.indexOf("--prompt") + 2)).toEqual([
      "--prompt",
      "System instructions\n\nImplement the change",
    ]);

    const enabledToolIndexes = command.args
      .map((arg, index) => (arg === "--enabled-tools" ? index : -1))
      .filter((index) => index >= 0);
    expect(enabledToolIndexes.map((index) => command.args[index + 1])).toEqual(["Read", "Bash"]);
  });

  test("continues the current Vibe session when requested without a resume id", async () => {
    const agent = new VibeAgent({ continueSession: true });

    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "Continue",
      options: {},
    });

    expect(command.args).toContain("-c");
    expect(command.args).not.toContain("--resume");
    expect(agent.issuedSessionId).toBeUndefined();
  });

  test("interprets Vibe streaming JSON through a subprocess run", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-vibe-args-"));
    const argsFile = join(argsFileDir, "args.json");
    const fake = await makeFakeVibe(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.VIBE_ARGS_FILE) fs.writeFileSync(process.env.VIBE_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write("not json\\n");
process.stdout.write(JSON.stringify({ role: "assistant", content: "Hello " }) + "\\n");
process.stdout.write(JSON.stringify({ role: "user", content: "ignored" }) + "\\n");
process.stdout.write(JSON.stringify({ role: "assistant", content: "world" }) + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.VIBE_ARGS_FILE = argsFile;
      /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
      const events = [];
      const agent = new VibeAgent({
        agent: "auto-approve",
        env: { PATH: process.env.PATH, VIBE_ARGS_FILE: argsFile },
      });

      const result = await agent.generate({
        prompt: "Say hello",
        rootDir: fake.dir,
        resumeSession: "vibe-session",
        onEvent: (event) => events.push(event),
      });

      expect(result.text).toBe("Hello world");
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "action",
        "action",
        "completed",
      ]);
      expect(events[0]).toMatchObject({
        type: "started",
        engine: "vibe",
        title: "Vibe",
        resume: "vibe-session",
      });
      expect(events[1]).toMatchObject({
        type: "action",
        engine: "vibe",
        phase: "updated",
        entryType: "message",
        action: { kind: "turn", title: "assistant" },
        message: "Hello ",
      });
      expect(events[2]).toMatchObject({
        type: "action",
        engine: "vibe",
        message: "world",
      });
      expect(events[3]).toMatchObject({
        type: "completed",
        engine: "vibe",
        ok: true,
        answer: "Hello world",
        resume: "vibe-session",
      });

      const capturedArgs = JSON.parse(await readFile(argsFile, "utf8"));
      expect(capturedArgs).toContain("--output");
      expect(capturedArgs).toContain("streaming");
      expect(capturedArgs.slice(capturedArgs.indexOf("--resume"), capturedArgs.indexOf("--resume") + 2)).toEqual([
        "--resume",
        "vibe-session",
      ]);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("reports stderr when Vibe exits before emitting assistant output", () => {
    const agent = new VibeAgent({ sessionId: "failed-session" });
    const interpreter = agent.createOutputInterpreter();

    expect(interpreter.onStdoutLine?.("")).toEqual([]);
    expect(interpreter.onStdoutLine?.("not json")).toEqual([]);
    expect(interpreter.onStdoutLine?.(JSON.stringify({ role: "user", content: "ignored" }))).toEqual([]);

    expect(interpreter.onExit?.({ exitCode: 7, stderr: "bad credentials\n" })).toEqual([
      {
        type: "started",
        engine: "vibe",
        title: "Vibe",
        resume: undefined,
      },
      {
        type: "completed",
        engine: "vibe",
        ok: false,
        answer: undefined,
        error: "bad credentials",
        resume: undefined,
      },
    ]);
    expect(interpreter.onExit?.({ exitCode: 7, stderr: "bad credentials\n" })).toEqual([]);
  });
});
