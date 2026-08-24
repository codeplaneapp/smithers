import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KimiAgent } from "../src/KimiAgent.js";

/**
 * Build a command with an isolated (empty) Kimi share dir so credential
 * probing never touches the developer machine's own ~/.kimi.
 * @param {import("../src/KimiAgentOptions.ts").KimiAgentOptions} opts
 * @param {Record<string, unknown>} [options]
 */
async function buildKimiCommand(opts, options = {}) {
  const shareDir = await mkdtemp(join(tmpdir(), "smithers-kimi-dialect-"));
  const agent = new KimiAgent({ configDir: shareDir, ...opts });
  const command = await agent.buildCommand({ prompt: "do the thing", cwd: process.cwd(), options });
  return { agent, command };
}

/**
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

describe("KimiAgent default dialect (unchanged)", () => {
  test("still emits the newer CLI surface and a synthetic session id", async () => {
    const { agent, command } = await buildKimiCommand({});
    try {
      expect(command.args).toContain("--print");
      expect(command.args).toContain("--work-dir");
      expect(command.args).toContain("--thinking");
      expect(command.args).toContain("--session");
      expect(typeof agent.issuedSessionId).toBe("string");
      expect(command.args).toContain("--prompt");
    } finally {
      await command.cleanup?.();
    }
  });
});

describe("KimiAgent cliVersion 0.29 dialect (vendor: @moonshot-ai/kimi-code@0.29.1)", () => {
  test("emits only flags the 0.29.x commander surface accepts", async () => {
    const { command } = await buildKimiCommand({
      cliVersion: "0.29",
      model: "kimi-k2",
      thinking: false,
      finalMessageOnly: true,
      maxStepsPerTurn: 5,
      maxRetriesPerStep: 2,
      maxRalphIterations: 1,
      mcpConfigFile: ["/mcp.json"],
      mcpConfig: ['{"m":1}'],
      workDir: "/tmp/somewhere",
      quiet: true,
      verbose: true,
      debug: true,
    });
    try {
      const args = command.args;
      // Flags only the newer CLI accepts must not leak into 0.29 argv.
      for (const newerOnly of [
        "--print",
        "--final-message-only",
        "--work-dir",
        "--thinking",
        "--no-thinking",
        "--max-steps-per-turn",
        "--max-retries-per-step",
        "--max-ralph-iterations",
        "--mcp-config-file",
        "--mcp-config",
        "--quiet",
        "--verbose",
        "--debug",
      ]) {
        expect(args).not.toContain(newerOnly);
      }
      // 0.29.x surface: -p/--prompt, --output-format, -m/--model, --yolo.
      expect(flagValues(args, "--prompt")).toEqual(["do the thing"]);
      expect(flagValues(args, "--output-format")).toEqual(["text"]);
      expect(flagValues(args, "--model")).toEqual(["kimi-k2"]);
      expect(args).toContain("--yolo");
    } finally {
      await command.cleanup?.();
    }
  });
  test("serializes each addDir as its own --add-dir pair", async () => {
    const { command } = await buildKimiCommand({ cliVersion: "0.29", addDir: ["/a", "/b"] });
    try {
      expect(flagValues(command.args, "--add-dir")).toEqual(["/a", "/b"]);
    } finally {
      await command.cleanup?.();
    }
  });
  test("never forwards a synthetic --session", async () => {
    const { agent, command } = await buildKimiCommand({ cliVersion: "0.29" });
    try {
      expect(command.args).not.toContain("--session");
      expect(agent.issuedSessionId).toBeUndefined();
    } finally {
      await command.cleanup?.();
    }
  });
  test("forwards a caller-supplied session id", async () => {
    const { agent, command } = await buildKimiCommand({ cliVersion: "0.29", session: "real-session-1" });
    try {
      expect(flagValues(command.args, "--session")).toEqual(["real-session-1"]);
      expect(agent.issuedSessionId).toBe("real-session-1");
    } finally {
      await command.cleanup?.();
    }
  });
  test("forwards a resumeSession id and honors --continue", async () => {
    const { command } = await buildKimiCommand({ cliVersion: "0.29", continue: true }, { resumeSession: "resume-9" });
    try {
      expect(flagValues(command.args, "--session")).toEqual(["resume-9"]);
      expect(command.args).toContain("--continue");
    } finally {
      await command.cleanup?.();
    }
  });
  test("passes agent/agentFile/skillsDir through the 0.29 surface", async () => {
    const { command } = await buildKimiCommand({
      cliVersion: "0.29",
      agent: "default",
      skillsDir: "/skills",
    });
    try {
      expect(flagValues(command.args, "--agent")).toEqual(["default"]);
      expect(flagValues(command.args, "--skills-dir")).toEqual(["/skills"]);
    } finally {
      await command.cleanup?.();
    }
  });
});
