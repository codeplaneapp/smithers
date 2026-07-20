import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgent } from "../src/CodexAgent.js";
import { runRealAgentE2E } from "./real-agent-e2e.js";

/**
 * E2E tests against the real OpenAI Codex CLI.
 * Skipped unless `SMITHERS_RUN_AGENT_E2E=1` and `codex` is installed on PATH.
 *
 * These tests invoke the actual CLI so they:
 *   - require valid OPENAI_API_KEY or a configured codex profile
 *   - may take 30–60s each (network + model inference)
 *   - are deterministic in structure but non-deterministic in model output
 */

let isCodexInstalled = false;
let supportsCodexE2EFlags = false;
try {
  execSync("which codex", { stdio: "pipe" });
  isCodexInstalled = true;
  const helpText = execSync("codex exec --help", {
    stdio: "pipe",
    encoding: "utf8",
  });
  supportsCodexE2EFlags =
    helpText.includes("--json") &&
    helpText.includes("--dangerously-bypass-approvals-and-sandbox") &&
    helpText.includes("--skip-git-repo-check");
} catch {
  isCodexInstalled = false;
  supportsCodexE2EFlags = false;
}

describe.skipIf(!runRealAgentE2E || !isCodexInstalled || !supportsCodexE2EFlags)(
  "CodexAgent E2E (real CLI)",
  () => {
  /** @type {string} */
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "smithers-codex-e2e-"));
    await writeFile(join(tmpDir, "hello.js"), 'console.log("hello world");\n');
  });

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends a simple prompt and gets a text response", async () => {
    const agent = new CodexAgent({
      yolo: true,
      skipGitRepoCheck: true,
    });

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

    const agent = new CodexAgent({
      yolo: true,
      skipGitRepoCheck: true,
    });

    const result = await agent.generate({
      prompt: "Say 'hello' and nothing else.",
      rootDir: tmpDir,
      onEvent: (event) => events.push(event),
    });

    expect(result).toBeDefined();
    expect(result.text.toLowerCase()).toContain("hello");

    // codex emits thread.started → "started" event
    const started = events.find((e) => e.type === "started");
    expect(started).toBeDefined();
    expect(started.engine).toBe("codex");

    // codex emits turn.completed → "completed" event
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect(completed.engine).toBe("codex");
    expect(completed.ok).toBe(true);
  }, 120_000);
  }
);
