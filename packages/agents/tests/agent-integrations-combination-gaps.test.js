import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";
import { CodexAgent } from "../src/CodexAgent.js";
import { ForgeAgent } from "../src/ForgeAgent.js";
import { KimiAgent } from "../src/KimiAgent.js";
import { VibeAgent } from "../src/VibeAgent.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @param {string[]} args
 * @param {string} flag
 * @returns {string | undefined}
 */
function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * @param {string[]} args
 * @param {string} flag
 * @returns {number}
 */
function flagCount(args, flag) {
  return args.filter((arg) => arg === flag).length;
}

describe("ClaudeCodeAgent option combinations", () => {
  test("default yolo adds bypassPermissions, but an explicit permissionMode wins", async () => {
    const defaulted = await new ClaudeCodeAgent({ model: "m" }).buildCommand({
      cwd: "/tmp/project",
      prompt: "hello",
      options: {},
    });
    expect(defaulted.args).toContain("--allow-dangerously-skip-permissions");
    expect(defaulted.args).toContain("--dangerously-skip-permissions");
    expect(flagCount(defaulted.args, "--permission-mode")).toBe(1);
    expect(flagValue(defaulted.args, "--permission-mode")).toBe("bypassPermissions");

    const planned = await new ClaudeCodeAgent({ model: "m", permissionMode: "plan" }).buildCommand({
      cwd: "/tmp/project",
      prompt: "hello",
      options: {},
    });
    expect(planned.args).toContain("--allow-dangerously-skip-permissions");
    expect(planned.args).toContain("--dangerously-skip-permissions");
    expect(flagCount(planned.args, "--permission-mode")).toBe(1);
    expect(flagValue(planned.args, "--permission-mode")).toBe("plan");
  });

  test("per-call resumeSession overrides the configured resume option", async () => {
    const command = await new ClaudeCodeAgent({ model: "m", resume: "opts-session" }).buildCommand({
      cwd: "/tmp/project",
      prompt: "continue",
      options: { resumeSession: "runtime-session" },
    });
    expect(flagCount(command.args, "--resume")).toBe(1);
    expect(flagValue(command.args, "--resume")).toBe("runtime-session");
    expect(command.args).not.toContain("opts-session");
  });

  test("durability settings stay additive with user settings and env merges all account vars", async () => {
    const command = await new ClaudeCodeAgent({
      model: "m",
      settings: "user-settings.json",
      configDir: "/tmp/claude-config",
      apiKey: "sk-test",
    }).buildCommand({
      cwd: "/tmp/project",
      prompt: "hello",
      options: { durabilitySocket: "/tmp/snap.sock" },
    });

    const settingsValues = command.args
      .map((arg, index) => (arg === "--settings" ? command.args[index + 1] : undefined))
      .filter((value) => value !== undefined);
    expect(settingsValues).toHaveLength(2);
    expect(settingsValues[0]).toBe("user-settings.json");
    const injected = JSON.parse(settingsValues[1]);
    expect(injected.hooks.PostToolUse[0].hooks[0].command).toBe("smithers snapshot-hook");

    expect(command.env).toEqual({
      SMITHERS_SNAPSHOT_SOCK: "/tmp/snap.sock",
      CLAUDE_CONFIG_DIR: "/tmp/claude-config",
      ANTHROPIC_API_KEY: "sk-test",
    });
    expect(command.args[command.args.length - 1]).toBe("hello");
  });

  test("tools boundary values: empty string and 'default' pass through, empty list drops the flag", async () => {
    const emptyString = await new ClaudeCodeAgent({ model: "m", tools: "" }).buildCommand({
      cwd: "/tmp/project",
      prompt: "hello",
      options: {},
    });
    expect(flagValue(emptyString.args, "--tools")).toBe("");

    const defaultTools = await new ClaudeCodeAgent({ model: "m", tools: "default" }).buildCommand({
      cwd: "/tmp/project",
      prompt: "hello",
      options: {},
    });
    expect(flagValue(defaultTools.args, "--tools")).toBe("default");

    const emptyList = await new ClaudeCodeAgent({ model: "m", tools: [] }).buildCommand({
      cwd: "/tmp/project",
      prompt: "hello",
      options: {},
    });
    expect(emptyList.args).not.toContain("--tools");
  });
});

describe("CodexAgent approval-mode precedence", () => {
  test("fullAuto emits --sandbox workspace-write and suppresses the dangerous bypass flag on fresh runs", async () => {
    const command = await new CodexAgent({
      fullAuto: true,
      dangerouslyBypassApprovalsAndSandbox: true,
    }).buildCommand({
      cwd: "/tmp/project",
      prompt: "go",
      options: {},
    });
    try {
      expect(command.args).not.toContain("--full-auto");
      const sandboxAt = command.args.indexOf("--sandbox");
      expect(command.args[sandboxAt + 1]).toBe("workspace-write");
      expect(command.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      await command.cleanup?.();
    }
  });

  test("an explicit sandbox wins over fullAuto without duplicating --sandbox", async () => {
    const command = await new CodexAgent({
      fullAuto: true,
      sandbox: "danger-full-access",
    }).buildCommand({
      cwd: "/tmp/project",
      prompt: "go",
      options: {},
    });
    try {
      expect(command.args).not.toContain("--full-auto");
      expect(command.args.filter((arg) => arg === "--sandbox")).toHaveLength(1);
      expect(command.args).toContain("danger-full-access");
      expect(command.args).not.toContain("workspace-write");
    } finally {
      await command.cleanup?.();
    }
  });

  test("resume drops the fullAuto sandbox and falls back to the dangerous bypass flag", async () => {
    const command = await new CodexAgent({
      fullAuto: true,
      dangerouslyBypassApprovalsAndSandbox: true,
    }).buildCommand({
      cwd: "/tmp/project",
      prompt: "continue",
      options: { resumeSession: "thread-1" },
    });
    try {
      expect(command.args).not.toContain("--sandbox");
      expect(command.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      await command.cleanup?.();
    }
  });
});

describe("ForgeAgent conversation inputs", () => {
  test("per-call resumeSession overrides the configured conversationId", async () => {
    const agent = new ForgeAgent({ conversationId: "configured-conv" });
    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "continue",
      options: { resumeSession: "runtime-conv" },
    });
    expect(flagValue(command.args, "--conversation-id")).toBe("runtime-conv");
    expect(agent.issuedConversationId).toBe("runtime-conv");
    expect(command.args).not.toContain("configured-conv");
  });

  test("generates a conversation id, defaults -C to cwd, and pairs workflow/event/conversation inputs", async () => {
    const agent = new ForgeAgent({
      workflow: "workflow.yaml",
      event: '{"kind":"push"}',
      conversation: "conversation.json",
    });
    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "go",
      options: {},
    });
    expect(flagValue(command.args, "--conversation-id")).toMatch(UUID_PATTERN);
    expect(agent.issuedConversationId).toBe(flagValue(command.args, "--conversation-id"));
    expect(flagValue(command.args, "-C")).toBe("/tmp/project");
    expect(flagValue(command.args, "--workflow")).toBe("workflow.yaml");
    expect(flagValue(command.args, "--event")).toBe('{"kind":"push"}');
    expect(flagValue(command.args, "--conversation")).toBe("conversation.json");
  });
});

describe("VibeAgent budget boundaries", () => {
  test("zero budget limits are emitted as 0, not dropped as falsy", async () => {
    const command = await new VibeAgent({
      maxTurns: 0,
      maxPrice: 0,
      maxTokens: 0,
    }).buildCommand({
      cwd: "/tmp/project",
      prompt: "go",
      options: {},
    });
    expect(flagValue(command.args, "--max-turns")).toBe("0");
    expect(flagValue(command.args, "--max-price")).toBe("0");
    expect(flagValue(command.args, "--max-tokens")).toBe("0");
  });
});

describe("KimiAgent session and step-limit combinations", () => {
  test("resumeSession wins over the configured session, workDir overrides cwd, and zero step limits survive", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "smithers-kimi-combo-"));
    const agent = new KimiAgent({
      configDir,
      session: "configured-session",
      workDir: "/tmp/elsewhere",
      maxStepsPerTurn: 0,
      maxRetriesPerStep: 0,
      maxRalphIterations: 0,
    });
    try {
      const command = await agent.buildCommand({
        cwd: "/tmp/project",
        prompt: "continue",
        options: { resumeSession: "runtime-session" },
      });
      expect(flagValue(command.args, "--session")).toBe("runtime-session");
      expect(agent.issuedSessionId).toBe("runtime-session");
      expect(command.args).not.toContain("configured-session");
      expect(flagValue(command.args, "--work-dir")).toBe("/tmp/elsewhere");
      expect(flagValue(command.args, "--max-steps-per-turn")).toBe("0");
      expect(flagValue(command.args, "--max-retries-per-step")).toBe("0");
      expect(flagValue(command.args, "--max-ralph-iterations")).toBe("0");
      expect(command.args).toContain("--thinking");
      await command.cleanup?.();
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
