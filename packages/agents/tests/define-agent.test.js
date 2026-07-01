/**
 * Failing tests for the eve-style defineAgent feature.
 * These encode the contract from .smithers/specs/eve-agent-authoring.md.
 * Tests FAIL until the implementation lands in packages/agents/src/defineAgent/.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// defineAgent will be exported from the agents package once implemented.
// This import fails until the feature exists -- that's the point.
import { defineAgent } from "../src/defineAgent/index.js";

// We also assert harness resolution maps to the correct existing adapter class.
import { ClaudeCodeAgent, CodexAgent } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal agent/ directory structure in a tmp dir. */
async function makeAgentDir(files = {}) {
  const base = await mkdtemp(join(tmpdir(), "smithers-agent-test-"));
  const agentDir = join(base, "agent");
  await mkdir(agentDir, { recursive: true });

  // Default: instructions.md with a system prompt
  const defaults = {
    "instructions.md": "You are a helpful research assistant.",
    ...files,
  };

  for (const [rel, content] of Object.entries(defaults)) {
    if (content === undefined) continue;
    const full = join(agentDir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  return { base, agentDir };
}

let cleanups = [];

afterEach(async () => {
  for (const dir of cleanups) {
    await rm(dir, { recursive: true, force: true });
  }
  cleanups = [];
});

// ---------------------------------------------------------------------------
// Contract: returns AgentLike
// ---------------------------------------------------------------------------

describe("defineAgent — SDK/custom agent", () => {
  test("returns an AgentLike with a generate function", async () => {
    const { base, agentDir } = await makeAgentDir();
    cleanups.push(base);

    const agent = await defineAgent({ model: "anthropic/claude-sonnet-4.6", agentDir });

    expect(typeof agent.generate).toBe("function");
  });

  test("instructions.md becomes the system prompt on the agent", async () => {
    const systemPrompt = "You are a specialist in TypeScript compilers.";
    const { base, agentDir } = await makeAgentDir({ "instructions.md": systemPrompt });
    cleanups.push(base);

    const agent = await defineAgent({ model: "anthropic/claude-sonnet-4.6", agentDir });

    // The agent must expose its resolved system prompt for inspection.
    expect(agent.instructions).toBe(systemPrompt);
  });

  test("agent without instructions.md is still valid (no system prompt)", async () => {
    const { base, agentDir } = await makeAgentDir({ "instructions.md": undefined });
    cleanups.push(base);
    // Remove the default file we wrote
    await rm(join(agentDir, "instructions.md"), { force: true });

    const agent = await defineAgent({ model: "anthropic/claude-sonnet-4.6", agentDir });

    expect(typeof agent.generate).toBe("function");
    expect(agent.instructions == null || agent.instructions === "").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Contract: tools/*.ts discovery
// ---------------------------------------------------------------------------

describe("defineAgent — tools discovery", () => {
  test("tools/*.ts files are loaded and registered on the agent", async () => {
    const toolSrc = `
import { defineTool } from "smithers-orchestrator/agent-kit";
import { z } from "zod";
export default defineTool({
  description: "Echo the input back.",
  inputSchema: z.object({ text: z.string() }),
  async execute({ text }) { return text; },
});
`;
    const { base, agentDir } = await makeAgentDir({ "tools/echo.ts": toolSrc });
    cleanups.push(base);

    const agent = await defineAgent({ model: "anthropic/claude-sonnet-4.6", agentDir });

    // The tool name is derived from the filename (without extension).
    expect(agent.tools).toBeDefined();
    expect(typeof agent.tools.echo).toBe("object");
  });

  test("tool filename (snake_case) becomes the tool name", async () => {
    const toolSrc = `
import { defineTool } from "smithers-orchestrator/agent-kit";
import { z } from "zod";
export default defineTool({
  description: "Search the web.",
  inputSchema: z.object({ query: z.string() }),
  async execute({ query }) { return []; },
});
`;
    const { base, agentDir } = await makeAgentDir({ "tools/search_web.ts": toolSrc });
    cleanups.push(base);

    const agent = await defineAgent({ model: "anthropic/claude-sonnet-4.6", agentDir });

    expect(agent.tools).toBeDefined();
    expect(typeof agent.tools.search_web).toBe("object");
  });

  test("agent with no tools/ dir still returns a valid AgentLike", async () => {
    const { base, agentDir } = await makeAgentDir();
    cleanups.push(base);

    const agent = await defineAgent({ model: "anthropic/claude-sonnet-4.6", agentDir });

    expect(typeof agent.generate).toBe("function");
    // Either undefined or empty object is acceptable.
    expect(agent.tools == null || Object.keys(agent.tools).length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Contract: skills discovery
// ---------------------------------------------------------------------------

describe("defineAgent — skills discovery", () => {
  test("skills/*.md files are attached to the agent manifest", async () => {
    const { base, agentDir } = await makeAgentDir({
      "skills/debugging.md": "# Debugging\nWhen debugging, start with logs.",
    });
    cleanups.push(base);

    const agent = await defineAgent({ model: "anthropic/claude-sonnet-4.6", agentDir });

    // Agent exposes the skill names discovered from skills/
    expect(agent.skills).toBeDefined();
    expect(agent.skills).toContain("debugging");
  });
});

// ---------------------------------------------------------------------------
// Contract: harness discriminator
// ---------------------------------------------------------------------------

describe("defineAgent — harness discriminator", () => {
  test("harness:'claude-code' returns a ClaudeCodeAgent-backed AgentLike", async () => {
    const { base, agentDir } = await makeAgentDir();
    cleanups.push(base);

    const agent = await defineAgent({
      harness: "claude-code",
      model: "claude-sonnet-4-6",
      agentDir,
    });

    expect(agent instanceof ClaudeCodeAgent).toBe(true);
  });

  test("harness:'codex' returns a CodexAgent-backed AgentLike", async () => {
    const { base, agentDir } = await makeAgentDir();
    cleanups.push(base);

    const agent = await defineAgent({
      harness: "codex",
      model: "gpt-5.5",
      options: { skipGitRepoCheck: true },
      agentDir,
    });

    expect(agent instanceof CodexAgent).toBe(true);
  });

  test("harness agent exposes instructions from instructions.md", async () => {
    const systemPrompt = "You are a code review specialist.";
    const { base, agentDir } = await makeAgentDir({ "instructions.md": systemPrompt });
    cleanups.push(base);

    const agent = await defineAgent({
      harness: "claude-code",
      model: "claude-sonnet-4-6",
      agentDir,
    });

    // The harness agent must surface the resolved instructions for inspection.
    expect(agent.instructions).toBe(systemPrompt);
  });

  test("unknown harness string throws a descriptive error", async () => {
    const { base, agentDir } = await makeAgentDir();
    cleanups.push(base);

    await expect(
      defineAgent({ harness: "nonexistent-harness", model: "gpt-5.5", agentDir }),
    ).rejects.toThrow(/unknown harness/i);
  });

  test("no harness + no model throws a descriptive error", async () => {
    const { base, agentDir } = await makeAgentDir();
    cleanups.push(base);

    await expect(defineAgent({ agentDir })).rejects.toThrow(/model.*required|harness.*required/i);
  });
});

// ---------------------------------------------------------------------------
// Contract: AgentLike assignability
// ---------------------------------------------------------------------------

describe("defineAgent — AgentLike interface", () => {
  test("result satisfies AgentLike shape (id, generate, optional tools)", async () => {
    const { base, agentDir } = await makeAgentDir();
    cleanups.push(base);

    const agent = await defineAgent({
      model: "anthropic/claude-sonnet-4.6",
      id: "test-researcher",
      agentDir,
    });

    expect(agent.id).toBe("test-researcher");
    expect(typeof agent.generate).toBe("function");
  });

  test("result from defineAgent array is a valid pool (array of AgentLike)", async () => {
    const { base: b1, agentDir: d1 } = await makeAgentDir();
    const { base: b2, agentDir: d2 } = await makeAgentDir();
    cleanups.push(b1, b2);

    const pool = await Promise.all([
      defineAgent({ model: "anthropic/claude-sonnet-4.6", agentDir: d1 }),
      defineAgent({ harness: "codex", model: "gpt-5.5", options: { skipGitRepoCheck: true }, agentDir: d2 }),
    ]);

    expect(Array.isArray(pool)).toBe(true);
    expect(pool.every((a) => typeof a.generate === "function")).toBe(true);
  });
});
