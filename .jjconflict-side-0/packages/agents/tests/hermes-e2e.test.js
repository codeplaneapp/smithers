import { describe, it, expect } from "bun:test";
import { HermesAgent } from "../src/HermesAgent.js";

/**
 * E2E tests against a real Hermes OpenAI-compatible backend.
 * Skipped entirely unless `HERMES_BASE_URL` points at a running backend.
 *
 * These tests invoke the actual HTTP backend so they:
 *   - require HERMES_BASE_URL and valid credentials if the server enforces them
 *   - may take 30-60s each (network + model inference)
 *   - are deterministic in structure but non-deterministic in model output
 */

const hasHermesBackend =
  process.env.HERMES_BASE_URL !== undefined &&
  process.env.HERMES_BASE_URL.trim() !== "";

describe.skipIf(!hasHermesBackend)(
  "HermesAgent E2E (real backend)",
  () => {
  it("sends a simple prompt and gets a text response", async () => {
    const agent = new HermesAgent();

    const result = await agent.generate({
      prompt: "What is 2+2? Reply with ONLY the number, nothing else.",
    });

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain("4");
  }, 120_000);

  it("streams stdout from the real backend", async () => {
    let streamedText = "";
    const agent = new HermesAgent();

    const result = await agent.generate({
      prompt: "Say 'hello' and nothing else.",
      onStdout: (text) => {
        streamedText += text;
      },
    });

    expect(result).toBeDefined();
    expect(result.text.toLowerCase()).toContain("hello");
    expect(streamedText.toLowerCase()).toContain("hello");
  }, 120_000);
  },
);
