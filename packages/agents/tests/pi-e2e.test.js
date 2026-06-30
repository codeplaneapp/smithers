import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAgent } from "../src/PiAgent.js";
import { runRealAgentE2E } from "./real-agent-e2e.js";

/**
 * E2E tests against the real Pi CLI.
 * Skipped unless `SMITHERS_RUN_AGENT_E2E=1` and `pi` is installed on PATH.
 *
 * These tests invoke the actual CLI so they:
 *   - require valid API credentials configured for pi's active provider
 *   - may take 30–60s each (network + model inference)
 *   - are deterministic in structure but non-deterministic in model output
 */

let isPiInstalled = false;
let supportsPiE2EFlags = false;
try {
  execSync("which pi", { stdio: "pipe" });
  isPiInstalled = true;
  const helpText = execSync("pi --help", {
    stdio: "pipe",
    encoding: "utf8",
  });
  supportsPiE2EFlags =
    helpText.includes("--print") &&
    helpText.includes("--mode") &&
    helpText.includes("--no-session");
} catch {
  isPiInstalled = false;
  supportsPiE2EFlags = false;
}

describe.skipIf(!runRealAgentE2E || !isPiInstalled || !supportsPiE2EFlags)(
  "PiAgent E2E (real CLI)",
  () => {
  /** @type {string} */
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "smithers-pi-e2e-"));
    await writeFile(join(tmpDir, "hello.js"), 'console.log("hello world");\n');
  });

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends a simple prompt and gets a text response", async () => {
    const agent = new PiAgent({ noSession: true });

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

    // noSession: false (session mode) so pi emits a JSON "session" event, which
    // triggers the "started" AgentCliEvent; noSession: true skips that event.
    const agent = new PiAgent({ noSession: false });

    const result = await agent.generate({
      prompt: "Say 'hello' and nothing else.",
      rootDir: tmpDir,
      onEvent: (event) => events.push(event),
    });

    expect(result).toBeDefined();
    expect(result.text.toLowerCase()).toContain("hello");

    // PiAgent emits "started" when it sees the json "session" event
    const started = events.find((e) => e.type === "started");
    expect(started).toBeDefined();
    expect(started.engine).toBe("pi");

    // PiAgent emits "completed" when it sees the json "agent_end" event
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeDefined();
    expect(completed.engine).toBe("pi");
    expect(completed.ok).toBe(true);
  }, 120_000);
  }
);
