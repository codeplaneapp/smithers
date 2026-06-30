import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeAgent } from "../src/ForgeAgent.js";
import { runRealAgentE2E } from "./real-agent-e2e.js";

/**
 * E2E tests against the real Forge CLI.
 * Skipped unless `SMITHERS_RUN_AGENT_E2E=1` and `forge` is installed on PATH.
 *
 * These tests invoke the actual CLI so they:
 *   - require valid API credentials configured in forge
 *   - may take 30–60s each (network + model inference)
 *   - are deterministic in structure but non-deterministic in model output
 */

let isForgeInstalled = false;
let supportsForgeE2EFlags = false;
try {
  execSync("which forge", { stdio: "pipe" });
  isForgeInstalled = true;
  const helpText = execSync("forge --help", {
    stdio: "pipe",
    encoding: "utf8",
  });
  supportsForgeE2EFlags =
    helpText.includes("--prompt") &&
    helpText.includes("-C");
} catch {
  isForgeInstalled = false;
  supportsForgeE2EFlags = false;
}

describe.skipIf(!runRealAgentE2E || !isForgeInstalled || !supportsForgeE2EFlags)(
  "ForgeAgent E2E (real CLI)",
  () => {
  /** @type {string} */
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "smithers-forge-e2e-"));
    await writeFile(join(tmpDir, "hello.js"), 'console.log("hello world");\n');
  });

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends a simple prompt and gets a text response", async () => {
    const agent = new ForgeAgent();

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

    const agent = new ForgeAgent();

    const result = await agent.generate({
      prompt: "Say 'hello' and nothing else.",
      rootDir: tmpDir,
      onEvent: (event) => events.push(event),
    });

    expect(result).toBeDefined();
    expect(result.text.toLowerCase()).toContain("hello");

    // ForgeAgent emits "started" on the first stdout line
    const started = events.find((e) => e.type === "started");
    expect(started).toBeDefined();
    expect(started.engine).toBe("forge");

    // ForgeAgent emits "completed" on exit
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect(completed.engine).toBe("forge");
    expect(completed.ok).toBe(true);
  }, 120_000);

  it("respects -C for working directory", async () => {
    const agent = new ForgeAgent();

    const result = await agent.generate({
      prompt:
        "List the files in the current directory. Just output the filenames, one per line.",
      rootDir: tmpDir,
    });

    expect(result).toBeDefined();
    expect(result.text).toContain("hello.js");
  }, 120_000);
  }
);
