import { describe, expect, test } from "bun:test";
import { GeminiAgent, GEMINI_SUNSET_MESSAGE, createGeminiCapabilityRegistry } from "../src/GeminiAgent.js";

describe("GeminiAgent sunset stub", () => {
  test("fails with Antigravity migration guidance instead of launching gemini", async () => {
    const agent = new GeminiAgent({ model: "gemini-3.1-pro-preview" });

    await expect(agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "ping",
      options: {},
    })).rejects.toThrow("Gemini CLI support has been sunset");

    await expect(agent.generate({ messages: [{ role: "user", content: "ping" }] })).rejects.toThrow("AntigravityAgent");
    expect(GEMINI_SUNSET_MESSAGE).toContain('new AntigravityAgent({ model: "gemini-3.1-pro-preview", cwd: process.cwd() })');
  });

  test("keeps a capability registry for compatibility, marked unsupported", () => {
    expect(createGeminiCapabilityRegistry()).toMatchObject({
      engine: "gemini",
      mcp: {
        bootstrap: "unsupported",
        supportsProjectScope: false,
        supportsUserScope: false,
      },
      builtIns: ["sunset"],
    });
  });

  test("interpreter reports the sunset message on exit", () => {
    const interpreter = new GeminiAgent().createOutputInterpreter();

    expect(interpreter.onStdoutLine("{}")).toEqual([]);
    expect(interpreter.onExit({ exitCode: 1, stdout: "", stderr: "" })).toEqual([
      {
        type: "completed",
        engine: "gemini",
        ok: false,
        error: GEMINI_SUNSET_MESSAGE,
      },
    ]);
  });
});
