import { describe, expect, test } from "bun:test";
import { GeminiAgent } from "../src/GeminiAgent.js";

async function buildGeminiCommand(agent, options = {}) {
  return agent.buildCommand({
    cwd: "/tmp/project",
    prompt: 'Return {"ok":true}\n\nREQUIRED OUTPUT: raw JSON',
    systemPrompt: "System instructions",
    options,
  });
}

describe("GeminiAgent", () => {
  test("builds Gemini command arguments for streamed execution", async () => {
    const agent = new GeminiAgent({
      debug: true,
      model: "gemini-2.5-pro",
      sandbox: true,
      approvalMode: "auto-edit",
      experimentalAcp: true,
      allowedMcpServerNames: ["filesystem", "github"],
      allowedTools: ["ReadFileTool", "ShellTool"],
      extensions: ["enterprise-extension"],
      includeDirectories: ["/tmp/project", "/tmp/shared"],
      screenReader: true,
      resume: "constructor-session",
      configDir: "/tmp/gemini-config",
      apiKey: "google-key",
      extraArgs: ["--custom", "value"],
    });

    const command = await buildGeminiCommand(agent, {
      onEvent: () => {},
      resumeSession: "call-session",
    });

    expect(command.command).toBe("gemini");
    expect(command.outputFormat).toBe("stream-json");
    expect(command.env).toEqual({
      GEMINI_DIR: "/tmp/gemini-config",
      GEMINI_API_KEY: "google-key",
    });
    expect(command.args).toContain("--debug");
    expect(command.args).toContain("--sandbox");
    expect(command.args).toContain("--experimental-acp");
    expect(command.args).toContain("--screen-reader");
    expect(command.args).toContain("--custom");
    expect(command.args).toContain("value");
    expect(command.args.slice(command.args.indexOf("--model"), command.args.indexOf("--model") + 2)).toEqual([
      "--model",
      "gemini-2.5-pro",
    ]);
    expect(command.args.slice(command.args.indexOf("--approval-mode"), command.args.indexOf("--approval-mode") + 2)).toEqual([
      "--approval-mode",
      "auto-edit",
    ]);
    expect(command.args.slice(command.args.indexOf("--allowed-mcp-server-names"), command.args.indexOf("--allowed-mcp-server-names") + 3)).toEqual([
      "--allowed-mcp-server-names",
      "filesystem",
      "github",
    ]);
    expect(command.args.slice(command.args.indexOf("--allowed-tools"), command.args.indexOf("--allowed-tools") + 3)).toEqual([
      "--allowed-tools",
      "ReadFileTool",
      "ShellTool",
    ]);
    expect(command.args.slice(command.args.indexOf("--extensions"), command.args.indexOf("--extensions") + 2)).toEqual([
      "--extensions",
      "enterprise-extension",
    ]);
    expect(command.args.slice(command.args.indexOf("--resume"), command.args.indexOf("--resume") + 2)).toEqual([
      "--resume",
      "call-session",
    ]);
    expect(command.args.slice(command.args.indexOf("--include-directories"), command.args.indexOf("--include-directories") + 3)).toEqual([
      "--include-directories",
      "/tmp/project",
      "/tmp/shared",
    ]);
    expect(command.args.slice(command.args.indexOf("--output-format"), command.args.indexOf("--output-format") + 2)).toEqual([
      "--output-format",
      "stream-json",
    ]);

    const prompt = command.args[command.args.indexOf("--prompt") + 1];
    expect(prompt).toStartWith("System instructions\n\n");
    expect(prompt).toContain('Return {"ok":true}');
    expect(prompt).toContain("REMINDER: Your response MUST be ONLY the required raw JSON object.");
  });

  test("builds JSON command arguments with inherited yolo and empty allowed tools", async () => {
    const agent = new GeminiAgent({ yolo: true, allowedTools: [] });
    agent.model = "fallback-model";

    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "Hello",
      options: {},
    });

    expect(command.outputFormat).toBe("json");
    expect(command.env).toBeUndefined();
    expect(command.args).toContain("--yolo");
    expect(command.args.slice(command.args.indexOf("--model"), command.args.indexOf("--model") + 2)).toEqual([
      "--model",
      "fallback-model",
    ]);
    expect(command.args.slice(command.args.indexOf("--allowed-tools"), command.args.indexOf("--allowed-tools") + 2)).toEqual([
      "--allowed-tools",
      "",
    ]);
    expect(command.args.slice(command.args.indexOf("--prompt"), command.args.indexOf("--prompt") + 2)).toEqual([
      "--prompt",
      "Hello",
    ]);
  });

  test("interprets Gemini JSON stream lifecycle events", () => {
    const interpreter = new GeminiAgent().createOutputInterpreter();

    expect(interpreter.onStdoutLine("")).toEqual([]);
    expect(interpreter.onStdoutLine("not json")).toEqual([]);
    expect(interpreter.onStdoutLine("[]")).toEqual([]);
    expect(interpreter.onStdoutLine(JSON.stringify({ nope: true }))).toEqual([]);

    expect(
      interpreter.onStdoutLine(
        JSON.stringify({
          type: "init",
          session_id: "gemini-session",
          model: "gemini-2.5-pro",
        }),
      ),
    ).toEqual([
      {
        type: "started",
        engine: "gemini",
        title: "Gemini CLI",
        resume: "gemini-session",
        detail: {
          model: "gemini-2.5-pro",
        },
      },
    ]);

    expect(interpreter.onStdoutLine(JSON.stringify({
      type: "MESSAGE",
      role: "user",
      content: "ignored",
    }))).toEqual([]);
    expect(interpreter.onStdoutLine(JSON.stringify({
      type: "MESSAGE",
      role: "assistant",
      content: "Final ",
      delta: true,
    }))).toEqual([]);
    expect(interpreter.onStdoutLine(JSON.stringify({
      type: "MESSAGE",
      role: "assistant",
      content: "answer",
      delta: true,
    }))).toEqual([]);

    expect(
      interpreter.onStdoutLine(
        JSON.stringify({
          type: "TOOL_USE",
          tool_name: "ReadFile",
          tool_id: "tool-1",
          parameters: { path: "README.md" },
        }),
      ),
    ).toEqual([
      {
        type: "action",
        engine: "gemini",
        phase: "started",
        entryType: "thought",
        action: {
          id: "tool-1",
          kind: "file_change",
          title: "ReadFile",
          detail: {
            parameters: { path: "README.md" },
          },
        },
        message: "Running ReadFile",
        level: "info",
      },
    ]);

    const syntheticToolUse = interpreter.onStdoutLine(JSON.stringify({
      type: "TOOL_USE",
    }));
    expect(syntheticToolUse).toHaveLength(1);
    expect(syntheticToolUse[0]).toMatchObject({
      message: "Running tool",
      action: { title: "tool", kind: "tool" },
    });
    expect(syntheticToolUse[0].action.id).toStartWith("gemini-tool-");

    expect(
      interpreter.onStdoutLine(
        JSON.stringify({
          type: "TOOL_RESULT",
          tool_id: "tool-1",
          status: "ok",
          output: "read ok",
        }),
      ),
    ).toEqual([
      {
        type: "action",
        engine: "gemini",
        phase: "completed",
        entryType: "thought",
        action: {
          id: "tool-1",
          kind: "tool",
          title: "tool result",
          detail: {
            status: "ok",
            output: "read ok",
          },
        },
        message: "read ok",
        ok: true,
        level: "info",
      },
    ]);

    expect(
      interpreter.onStdoutLine(
        JSON.stringify({
          type: "TOOL_RESULT",
          status: "error",
          error: { message: "read failed" },
        }),
      )[0],
    ).toMatchObject({
      ok: false,
      message: "read failed",
      level: "warning",
      action: { title: "tool result" },
    });

    expect(
      interpreter.onStdoutLine(
        JSON.stringify({
          type: "ERROR",
          severity: "warning",
          message: "heads up",
        }),
      )[0],
    ).toMatchObject({
      type: "action",
      engine: "gemini",
      phase: "completed",
      ok: true,
      level: "warning",
      message: "heads up",
      action: {
        kind: "warning",
        title: "warning",
        detail: { severity: "warning" },
      },
    });
    expect(
      interpreter.onStdoutLine(
        JSON.stringify({
          type: "ERROR",
          severity: "error",
          message: "hard failure",
        }),
      )[0],
    ).toMatchObject({
      ok: false,
      level: "error",
      message: "hard failure",
      action: {
        kind: "warning",
        detail: { severity: "error" },
      },
    });

    expect(
      interpreter.onStdoutLine(
        JSON.stringify({
          type: "RESULT",
          status: "ok",
          response: "fallback",
          stats: { inputTokens: 3 },
        }),
      ),
    ).toEqual([
      {
        type: "completed",
        engine: "gemini",
        ok: true,
        answer: "Final answer",
        resume: "gemini-session",
        usage: { inputTokens: 3 },
      },
    ]);
    expect(interpreter.onStdoutLine(JSON.stringify({ type: "RESULT" }))).toEqual([]);
    expect(interpreter.onExit({ exitCode: 2, stderr: "late failure\n" })).toEqual([]);
  });

  test("interprets Gemini result errors and process exits", () => {
    const resultError = new GeminiAgent().createOutputInterpreter();
    expect(resultError.onStdoutLine(JSON.stringify({
      type: "MESSAGE",
      role: "assistant",
      content: "overwritten",
    }))).toEqual([]);
    expect(resultError.onStdoutLine(JSON.stringify({
      type: "MESSAGE",
      role: "assistant",
      content: "partial",
    }))).toEqual([]);
    expect(
      resultError.onStdoutLine(
        JSON.stringify({
          type: "RESULT",
          status: "error",
          response: "fallback",
        }),
      ),
    ).toEqual([
      {
        type: "completed",
        engine: "gemini",
        ok: false,
        answer: "partial",
        resume: undefined,
        usage: undefined,
      },
    ]);

    const responseFallback = new GeminiAgent().createOutputInterpreter();
    expect(responseFallback.onStdoutLine(JSON.stringify({
      type: "RESULT",
      status: "ok",
      response: "fallback response",
    }))).toEqual([
      {
        type: "completed",
        engine: "gemini",
        ok: true,
        answer: "fallback response",
        resume: undefined,
        usage: undefined,
      },
    ]);

    const exited = new GeminiAgent().createOutputInterpreter();
    expect(exited.onExit({ exitCode: 0, stderr: "" })).toEqual([]);
    expect(exited.onStdoutLine(JSON.stringify({
      type: "init",
      session_id: "exit-session",
    }))).toHaveLength(1);
    expect(exited.onStdoutLine(JSON.stringify({
      type: "MESSAGE",
      role: "assistant",
      content: "draft",
    }))).toEqual([]);
    expect(exited.onExit({ exitCode: 9, stderr: "boom\n" })).toEqual([
      {
        type: "completed",
        engine: "gemini",
        ok: false,
        answer: "draft",
        error: "boom",
        resume: "exit-session",
      },
    ]);

    const fallbackExit = new GeminiAgent().createOutputInterpreter();
    expect(fallbackExit.onExit({ exitCode: 3, stderr: "" })[0].error).toBe(
      "Gemini exited with code 3",
    );
  });
});
