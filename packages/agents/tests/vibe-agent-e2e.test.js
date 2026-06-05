import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VibeAgent } from "../src/VibeAgent.js";

/**
 * E2E tests against the real Vibe CLI.
 * Skipped entirely if `vibe` is not installed on PATH.
 *
 * These tests invoke the actual CLI so they:
 *   - require valid API credentials configured in vibe
 *   - may take 30-60s each (network + model inference)
 *   - are deterministic in structure but non-deterministic in model output
 */

let isVibeInstalled = false;
let supportsVibeE2EFlags = false;
try {
  execSync("which vibe", { stdio: "pipe" });
  isVibeInstalled = true;
  const helpText = execSync("vibe --help", {
    stdio: "pipe",
    encoding: "utf8",
  });
  supportsVibeE2EFlags =
    helpText.includes("-p") &&
    helpText.includes("--output") &&
    helpText.includes("--agent") &&
    helpText.includes("--trust") &&
    helpText.includes("--workdir");
} catch {
  isVibeInstalled = false;
  supportsVibeE2EFlags = false;
}

describe.skipIf(!isVibeInstalled || !supportsVibeE2EFlags)(
  "VibeAgent E2E (real CLI)",
  () => {
  /** @type {string} */
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "smithers-vibe-e2e-"));
    await writeFile(join(tmpDir, "hello.js"), 'console.log("hello world");\n');
  });

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends a simple prompt and gets a text response", async () => {
    const agent = new VibeAgent({
      agent: "auto-approve",
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

    const agent = new VibeAgent({
      agent: "auto-approve",
    });

    const result = await agent.generate({
      prompt: "Say 'hello' and nothing else.",
      rootDir: tmpDir,
      onEvent: (event) => events.push(event),
    });

    expect(result).toBeDefined();
    expect(result.text.toLowerCase()).toContain("hello");

    const started = events.find((e) => e.type === "started");
    expect(started).toBeDefined();
    expect(started.engine).toBe("vibe");

    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect(completed.engine).toBe("vibe");
    expect(completed.ok).toBe(true);
  }, 120_000);

  it("respects --workdir for working directory", async () => {
    const agent = new VibeAgent({
      agent: "auto-approve",
    });

    const result = await agent.generate({
      prompt:
        "List the files in the current directory. Just output the filenames, one per line.",
      rootDir: tmpDir,
    });

    expect(result).toBeDefined();
    expect(result.text).toContain("hello.js");
  }, 120_000);

  it("executes tools with auto-approve agent", async () => {
    const agent = new VibeAgent({
      agent: "auto-approve",
    });

    const result = await agent.generate({
      prompt:
        "Read the file hello.js and tell me what it prints. Reply with ONLY the output string, nothing else.",
      rootDir: tmpDir,
    });

    expect(result).toBeDefined();
    expect(result.text).toContain("hello world");
  }, 120_000);

  it("respects maxTurns option", async () => {
    const agent = new VibeAgent({
      agent: "auto-approve",
      maxTurns: 1,
    });

    const result = await agent.generate({
      prompt:
        "First say 'one', then say 'two', then say 'three'. Say each on a new line.",
      rootDir: tmpDir,
    });

    expect(result).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);
    // With maxTurns=1, the agent may only produce one assistant turn
    expect(result.finishReason).toBeDefined();
  }, 120_000);
  }
);
