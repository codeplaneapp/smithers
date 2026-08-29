import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";
import { runRealAgentE2E } from "./real-agent-e2e.js";

/**
 * E2E tests against the real Claude Code CLI.
 * Skipped unless `SMITHERS_RUN_AGENT_E2E=1` and `claude` is installed on PATH.
 *
 * These tests invoke the actual CLI so they:
 *   - require a valid Claude Code subscription or ANTHROPIC_API_KEY
 *   - may take 30–60s each (network + model inference)
 *   - are deterministic in structure but non-deterministic in model output
 */

let isClaudeInstalled = false;
let supportsClaudeE2EFlags = false;
try {
  execSync("which claude", { stdio: "pipe" });
  isClaudeInstalled = true;
  const helpText = execSync("claude --help", {
    stdio: "pipe",
    encoding: "utf8",
  });
  supportsClaudeE2EFlags =
    helpText.includes("--print") &&
    helpText.includes("--output-format") &&
    helpText.includes("--dangerously-skip-permissions");
} catch {
  isClaudeInstalled = false;
  supportsClaudeE2EFlags = false;
}

describe.skipIf(!runRealAgentE2E || !isClaudeInstalled || !supportsClaudeE2EFlags)(
  "ClaudeCodeAgent E2E (real CLI)",
  () => {
    /** @type {string} */
    let tmpDir;

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "smithers-claude-e2e-"));
      await writeFile(join(tmpDir, "hello.js"), 'console.log("hello world");\n');
    });

    afterAll(async () => {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("sends a simple prompt and gets a text response", async () => {
      const agent = new ClaudeCodeAgent({ yolo: true });

      const result = await agent.generate({
        prompt: "What is 2+2? Reply with ONLY the number, nothing else.",
        rootDir: tmpDir,
      });

      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text).toContain("4");
    }, 120_000);

    it("emits events with correct structure", async () => {
      /** @type {import("../src/BaseCliAgent/index.ts").AgentCliEvent[]} */
      const events = [];

      const agent = new ClaudeCodeAgent({ yolo: true });

      const result = await agent.generate({
        prompt: "Say 'hello' and nothing else.",
        rootDir: tmpDir,
        onEvent: (event) => events.push(event),
      });

      expect(result).toBeDefined();
      expect(result.text.toLowerCase()).toContain("hello");

      const started = events.find((e) => e.type === "started");
      expect(started).toBeDefined();
      expect(started.engine).toBe("claude-code");

      const completed = events.find((e) => e.type === "completed");
      expect(completed).toBeDefined();
      expect(completed.engine).toBe("claude-code");
      expect(completed.ok).toBe(true);
    }, 120_000);

    it("executes tools with dangerously-skip-permissions (yolo mode)", async () => {
      const agent = new ClaudeCodeAgent({ yolo: true });

      const result = await agent.generate({
        prompt: "Read the file hello.js and tell me what it prints. Reply with ONLY the output string, nothing else.",
        rootDir: tmpDir,
      });

      expect(result).toBeDefined();
      expect(result.text).toContain("hello world");
    }, 120_000);
  },
);
