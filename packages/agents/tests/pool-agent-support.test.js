import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PoolAgent, createPoolCapabilityRegistry } from "../src/PoolAgent.js";

const originalPath = process.env.PATH ?? "";

/**
 * @param {string} stdoutScript
 */
async function makeFakePool(stdoutScript) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-pool-test-"));
  const binPath = join(dir, "pool");
  const script = `#!/usr/bin/env node\n${stdoutScript}\n`;
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  return { dir, binPath };
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.POOL_ARGS_FILE;
});

describe("PoolAgent", () => {
  test("builds pool command arguments for streamed execution", async () => {
    const agent = new PoolAgent({
      agentName: "default",
      model: "test-model",
      sandbox: "required",
    });

    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "Implement the change",
      systemPrompt: "System instructions",
      options: {},
    });

    expect(command.command).toBe("pool");
    expect(command.outputFormat).toBe("stream-json");
    expect(command.args).toContain("exec");
    expect(command.args).toContain("-o");
    expect(command.args).toContain("json");
    expect(command.args).toContain("--unsafe-auto-allow");
    expect(command.args).toContain("--sandbox");
    expect(command.args).toContain("required");

    const indexD = command.args.indexOf("-d");
    expect(indexD).toBeGreaterThan(-1);
    expect(command.args[indexD + 1]).toBe("/tmp/project");

    const indexM = command.args.indexOf("-m");
    expect(indexM).toBeGreaterThan(-1);
    expect(command.args[indexM + 1]).toBe("test-model");

    const indexA = command.args.indexOf("-a");
    expect(indexA).toBeGreaterThan(-1);
    expect(command.args[indexA + 1]).toBe("default");
  });

  test("builds pool command with resume session", async () => {
    const agent = new PoolAgent({
      resumeSession: "previous-session",
    });

    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "Continue",
      options: {},
    });

    const indexR = command.args.indexOf("-r");
    expect(indexR).toBeGreaterThan(-1);
    expect(command.args[indexR + 1]).toBe("previous-session");
  });

  test("creates capability registry with correct properties", () => {
    const registry = createPoolCapabilityRegistry();

    expect(registry.version).toBe(1);
    expect(registry.engine).toBe("pool");
    expect(registry.mcp.bootstrap).toBe("project-config");
    expect(registry.mcp.supportsProjectScope).toBe(true);
    expect(registry.mcp.supportsUserScope).toBe(true);
    expect(registry.skills.supportsSkills).toBe(true);
    expect(registry.skills.installMode).toBe("plugin");
    expect(registry.humanInteraction.supportsUiRequests).toBe(false);
  });

  test("interprets pool streaming JSON through a subprocess run", async () => {
    const argsFileDir = await mkdtemp(join(tmpdir(), "smithers-pool-args-"));
    const argsFile = join(argsFileDir, "args.json");
    const fake = await makeFakePool(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.POOL_ARGS_FILE) fs.writeFileSync(process.env.POOL_ARGS_FILE, JSON.stringify(args), "utf8");
process.stdout.write(JSON.stringify({ reasoning: "thinking...", type: "reasoning" }) + "\\n");
process.stdout.write(JSON.stringify({ thought: "I'll help you.", type: "thought" }) + "\\n");
process.stdout.write(JSON.stringify({ args: {}, name: "write", type: "toolCall" }) + "\\n");
process.stdout.write(JSON.stringify({ result: "Wrote file", type: "toolCallResult" }) + "\\n");
process.stdout.write(JSON.stringify({ thought: "Done!", type: "thought" }) + "\\n");
process.stdout.write(JSON.stringify({ args: { success: true }, name: "exit", type: "toolCall" }) + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      process.env.POOL_ARGS_FILE = argsFile;
      /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
      const events = [];
      const agent = new PoolAgent({
        env: { PATH: process.env.PATH, POOL_ARGS_FILE: argsFile },
      });

      const result = await agent.generate({
        prompt: "Do something",
        rootDir: fake.dir,
        onEvent: (event) => events.push(event),
      });

      expect(result.text).toBe("Done!");
      // Verify we got started, some actions, and completed
      expect(events.some(e => e.type === "started")).toBe(true);
      expect(events.some(e => e.type === "completed")).toBe(true);
      const completed = events.find(e => e.type === "completed");
      expect(completed).toMatchObject({
        engine: "pool",
        ok: true,
        answer: "Done!",
      });
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
      await rm(argsFileDir, { recursive: true, force: true });
    }
  });

  test("preserves an answer when the first pool NDJSON record is a thought", async () => {
    const fake = await makeFakePool(`
process.stdout.write(JSON.stringify({ thought: "First record answer", type: "thought" }) + "\\n");
process.stdout.write(JSON.stringify({ args: { success: true }, name: "exit", type: "toolCall" }) + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
      const events = [];
      const agent = new PoolAgent({ env: { PATH: process.env.PATH } });

      const result = await agent.generate({
        prompt: "Return the first answer",
        rootDir: fake.dir,
        onEvent: (event) => events.push(event),
      });

      expect(result.text).toBe("First record answer");
      expect(events[0]).toMatchObject({ type: "started", engine: "pool" });
      expect(events[1]).toMatchObject({
        type: "action",
        engine: "pool",
        entryType: "message",
        message: "First record answer",
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "completed",
          engine: "pool",
          ok: true,
          answer: "First record answer",
        }),
      ]));
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("fails when the first pool NDJSON record is a failing exit", async () => {
    const fake = await makeFakePool(`
process.stdout.write(JSON.stringify({ args: { success: false }, name: "exit", type: "toolCall" }) + "\\n");
`);

    try {
      process.env.PATH = `${fake.dir}:${originalPath}`;
      /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
      const events = [];
      const agent = new PoolAgent({ env: { PATH: process.env.PATH } });

      await expect(agent.generate({
        prompt: "Fail immediately",
        rootDir: fake.dir,
        onEvent: (event) => events.push(event),
      })).rejects.toMatchObject({ code: "AGENT_CLI_ERROR" });

      expect(events[0]).toMatchObject({ type: "started", engine: "pool" });
      expect(events[1]).toMatchObject({ type: "completed", engine: "pool", ok: false });
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test("reports stderr when pool exits before emitting output", () => {
    const agent = new PoolAgent({ sessionId: "failed-session" });
    const interpreter = agent.createOutputInterpreter();

    expect(interpreter.onStdoutLine?.("")).toEqual([]);
    expect(interpreter.onStdoutLine?.("not json")).toEqual([]);

    const exitEvents = interpreter.onExit?.({ exitCode: 7, stderr: "bad credentials\n" }) ?? [];
    
    // Should have both started and completed events
    expect(exitEvents.length).toBe(2);
    expect(exitEvents[0]).toMatchObject({
      type: "started",
      engine: "pool",
      title: "Pool",
    });
    expect(exitEvents[1]).toMatchObject({
      type: "completed",
      engine: "pool",
      ok: false,
      answer: undefined,
      error: "bad credentials",
    });
    expect(interpreter.onExit?.({ exitCode: 7, stderr: "bad credentials\n" })).toEqual([]);
  });
});
