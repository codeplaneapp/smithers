import { describe, it, expect } from "bun:test";
import { GeminiAgent, GEMINI_SUNSET_MESSAGE } from "../src/GeminiAgent.js";

/**
 * Behavioral tests for the sunset GeminiAgent.
 *
 * GeminiAgent has been sunset: both generate() and buildCommand() throw a
 * descriptive error directing users to AntigravityAgent + the `agy` CLI.
 * These tests verify that real behavior — no mocks needed, no CLI binary.
 */

describe("GeminiAgent (sunset)", () => {
  it("throws sunset error on generate()", async () => {
    const agent = new GeminiAgent();
    await expect(
      agent.generate({ prompt: "What is 2+2?", rootDir: "/tmp" }),
    ).rejects.toThrow(GEMINI_SUNSET_MESSAGE);
  });

  it("throws sunset error on buildCommand()", async () => {
    const agent = new GeminiAgent();
    await expect(
      agent.buildCommand({ prompt: "What is 2+2?", cwd: "/tmp", options: {} }),
    ).rejects.toThrow(GEMINI_SUNSET_MESSAGE);
  });

  it("createOutputInterpreter always emits a failed completed event", () => {
    const agent = new GeminiAgent();
    const interpreter = agent.createOutputInterpreter();

    // onStdoutLine emits nothing (the output is never used, generate() throws first)
    expect(interpreter.onStdoutLine("some line")).toEqual([]);

    // onExit always returns the sunset error as a completed event
    const exitEvents = interpreter.onExit({
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
    });
    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].type).toBe("completed");
    expect(exitEvents[0].ok).toBe(false);
    expect(exitEvents[0].error).toContain("sunset");
    expect(exitEvents[0].engine).toBe("gemini");
  });
});
