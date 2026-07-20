import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiAgent } from "../src/KimiAgent.js";
import { runRealAgentE2E } from "./real-agent-e2e.js";

/**
 * E2E tests against the real Kimi CLI.
 * Skipped unless `SMITHERS_RUN_AGENT_E2E=1` and `kimi` is installed on PATH.
 *
 * These tests invoke the actual CLI so they:
 *   - require valid Kimi credentials (OAuth or API key)
 *   - may take 30–60s each (network + model inference)
 *   - are deterministic in structure but non-deterministic in model output
 */

let isKimiInstalled = false;
let supportsKimiE2EFlags = false;
try {
  execSync("which kimi", { stdio: "pipe" });
  isKimiInstalled = true;
  const helpText = execSync("kimi --help", {
    stdio: "pipe",
    encoding: "utf8",
  });
  supportsKimiE2EFlags =
    helpText.includes("--print") &&
    helpText.includes("--work-dir") &&
    helpText.includes("--output-format");
} catch {
  isKimiInstalled = false;
  supportsKimiE2EFlags = false;
}

describe.skipIf(!runRealAgentE2E || !isKimiInstalled || !supportsKimiE2EFlags)(
  "KimiAgent E2E (real CLI)",
  () => {
  /** @type {string} */
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "smithers-kimi-e2e-"));
    await writeFile(join(tmpDir, "hello.js"), 'console.log("hello world");\n');
  });

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends a simple prompt and gets a text response", async () => {
    const agent = new KimiAgent();

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

    // Passing onEvent switches kimi to --output-format stream-json
    const agent = new KimiAgent();

    const result = await agent.generate({
      prompt: "Say 'hello' and nothing else.",
      rootDir: tmpDir,
      onEvent: (event) => events.push(event),
    });

    expect(result).toBeDefined();
    expect(result.text.toLowerCase()).toContain("hello");

    // KimiAgent emits "started" on the first parsed JSON line from stream-json output
    const started = events.find((e) => e.type === "started");
    expect(started).toBeDefined();
    expect(started.engine).toBe("kimi");

    // KimiAgent emits "completed" on process exit
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect(completed.engine).toBe("kimi");
    expect(completed.ok).toBe(true);
  }, 120_000);

  it("respects --work-dir for working directory", async () => {
    const agent = new KimiAgent();

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
