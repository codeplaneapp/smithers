import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {{ args: string[] }} command */
function settingsPathOf(command) {
  const index = command.args.indexOf("--settings");
  if (index < 0 || typeof command.args[index + 1] !== "string") {
    throw new Error("expected a --settings file path");
  }
  return command.args[index + 1];
}

class RecordingClaudeCodeAgent extends ClaudeCodeAgent {
  settingsPath;
  commandOverride;

  /**
   * @param {import("../src/ClaudeCodeAgentOptions.ts").ClaudeCodeAgentOptions} opts
   * @param {string} [commandOverride]
   */
  constructor(opts, commandOverride) {
    super(opts);
    this.commandOverride = commandOverride;
  }

  /** @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any }} params */
  async buildCommand(params) {
    const command = await super.buildCommand(params);
    this.settingsPath = settingsPathOf(command);
    return this.commandOverride ? { ...command, command: this.commandOverride } : command;
  }
}

async function expectRecordedSettingsRemoved(agent) {
  expect(typeof agent.settingsPath).toBe("string");
  expect(await exists(agent.settingsPath)).toBe(false);
  expect(await exists(dirname(agent.settingsPath))).toBe(false);
}

describe("ClaudeCodeAgent private settings cleanup", () => {
  test("direct command cleanup removes the private file and directory idempotently", async () => {
    const command = await new ClaudeCodeAgent({ effort: "high" }).buildCommand({
      prompt: "hello",
      cwd: process.cwd(),
      options: {},
    });
    const settingsPath = settingsPathOf(command);
    expect(await exists(settingsPath)).toBe(true);
    expect(await exists(dirname(settingsPath))).toBe(true);
    expect(typeof command.cleanup).toBe("function");

    await command.cleanup();
    await command.cleanup();

    expect(await exists(settingsPath)).toBe(false);
    expect(await exists(dirname(settingsPath))).toBe(false);
  });

  test("BaseCliAgent cleanup removes settings when generation fails", async () => {
    const agent = new RecordingClaudeCodeAgent(
      { effort: "high" },
      "smithers-claude-cleanup-command-that-does-not-exist",
    );

    await expect(agent.generate({ prompt: "hello" })).rejects.toThrow();

    await expectRecordedSettingsRemoved(agent);
  });

  test("a serialization failure removes the directory created before the write", async () => {
    const isolatedTmp = await mkdtemp(join(tmpdir(), "smithers-claude-cleanup-partial-"));
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;
    try {
      const agent = new ClaudeCodeAgent({ settings: { unserializable: 1n } });

      await expect(agent.buildCommand({ prompt: "hello", cwd: process.cwd(), options: {} })).rejects.toThrow();

      expect(await readdir(isolatedTmp)).toEqual([]);
    } finally {
      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdir;
      }
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  });
});
