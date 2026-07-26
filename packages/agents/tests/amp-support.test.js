import { describe, expect, test } from "bun:test";
import { AmpAgent } from "../src/AmpAgent.js";

describe("AmpAgent", () => {
  test("exposes Amp capability metadata", () => {
    const agent = new AmpAgent();

    expect(agent.cliEngine).toBe("amp");
    expect(agent.capabilities).toMatchObject({
      version: 1,
      engine: "amp",
      mcp: {
        bootstrap: "project-config",
        supportsProjectScope: true,
        supportsUserScope: false,
      },
      skills: {
        supportsSkills: false,
        smithersSkillIds: [],
      },
      humanInteraction: {
        supportsUiRequests: false,
        methods: [],
      },
      builtIns: ["default"],
    });
  });

  test("builds Amp command arguments for streamed execution", async () => {
    const agent = new AmpAgent({
      dangerouslyAllowAll: true,
      model: "amp-model",
      visibility: "private",
      mcpConfig: "mcp.json",
      settingsFile: "settings.json",
      logLevel: "debug",
      logFile: "amp.log",
      extraArgs: ["--custom", "value"],
    });

    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "Implement the change",
      systemPrompt: "System instructions",
      options: { onEvent: () => {} },
    });

    expect(command.command).toBe("amp");
    expect(command.outputFormat).toBe("stream-json");
    expect(command.args).toContain("--dangerously-allow-all");
    expect(command.args).toContain("--no-ide");
    expect(command.args).toContain("--no-jetbrains");
    expect(command.args).toContain("--no-color");
    expect(command.args).toContain("--archive");
    expect(command.args).toContain("--stream-json");
    expect(command.args).toContain("--custom");
    expect(command.args).toContain("value");
    expect(command.args.slice(command.args.indexOf("--model"), command.args.indexOf("--model") + 2)).toEqual([
      "--model",
      "amp-model",
    ]);
    expect(command.args.slice(command.args.indexOf("--visibility"), command.args.indexOf("--visibility") + 2)).toEqual([
      "--visibility",
      "private",
    ]);
    expect(command.args.slice(command.args.indexOf("--mcp-config"), command.args.indexOf("--mcp-config") + 2)).toEqual([
      "--mcp-config",
      "mcp.json",
    ]);
    expect(
      command.args.slice(command.args.indexOf("--settings-file"), command.args.indexOf("--settings-file") + 2),
    ).toEqual(["--settings-file", "settings.json"]);
    expect(command.args.slice(command.args.indexOf("--log-level"), command.args.indexOf("--log-level") + 2)).toEqual([
      "--log-level",
      "debug",
    ]);
    expect(command.args.slice(command.args.indexOf("--log-file"), command.args.indexOf("--log-file") + 2)).toEqual([
      "--log-file",
      "amp.log",
    ]);

    const executeIndex = command.args.indexOf("--execute");
    expect(command.args[executeIndex + 1]).toBe("System instructions\n\nImplement the change");
  });

  test("builds text command arguments with inherited yolo and model options", async () => {
    const agent = new AmpAgent({ yolo: true });
    agent.model = "fallback-model";

    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "Hello",
      options: {},
    });

    expect(command.outputFormat).toBe("text");
    expect(command.args).toContain("--dangerously-allow-all");
    expect(command.args.slice(command.args.indexOf("--model"), command.args.indexOf("--model") + 2)).toEqual([
      "--model",
      "fallback-model",
    ]);
    expect(command.args).not.toContain("--stream-json");
    expect(command.args[command.args.indexOf("--execute") + 1]).toBe("Hello");
  });

  test("enables IDE integrations when explicitly requested", async () => {
    const ideCommand = await new AmpAgent({ ide: true }).buildCommand({
      cwd: "/tmp/project",
      prompt: "Hello",
      options: {},
    });
    const jetbrainsCommand = await new AmpAgent({ jetbrains: true }).buildCommand({
      cwd: "/tmp/project",
      prompt: "Hello",
      options: {},
    });

    expect(ideCommand.args).not.toContain("--no-ide");
    expect(ideCommand.args).toContain("--no-jetbrains");
    expect(jetbrainsCommand.args).toContain("--no-ide");
    expect(jetbrainsCommand.args).not.toContain("--no-jetbrains");
  });

  test("interprets Amp JSON stream lifecycle events", () => {
    const agent = new AmpAgent();
    const interpreter = agent.createOutputInterpreter();

    expect(interpreter.onStdoutLine("")).toEqual([]);
    expect(interpreter.onStdoutLine("not json")).toEqual([]);
    expect(interpreter.onStdoutLine("[]")).toEqual([]);
    expect(interpreter.onStdoutLine(JSON.stringify({ nope: true }))).toEqual([]);

    expect(
      interpreter.onStdoutLine(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "amp-session",
          cwd: "/tmp/project",
          tools: ["Read", "Bash"],
        }),
      ),
    ).toEqual([
      {
        type: "started",
        engine: "amp",
        title: "Amp",
        resume: "amp-session",
        detail: {
          cwd: "/tmp/project",
          tools: ["Read", "Bash"],
        },
      },
    ]);

    const actionEvents = interpreter.onStdoutLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Final " },
            {
              type: "tool_use",
              name: "Bash",
              input: { cmd: "echo ok" },
            },
            { type: "text", text: "answer" },
          ],
        },
        parent_tool_use_id: "parent-1",
      }),
    );
    expect(actionEvents).toHaveLength(1);
    expect(actionEvents[0]).toMatchObject({
      type: "action",
      engine: "amp",
      phase: "started",
      entryType: "thought",
      message: "Running Bash",
      level: "info",
      action: {
        title: "Bash",
        detail: {
          input: { cmd: "echo ok" },
          parentToolUseId: "parent-1",
        },
      },
    });
    expect(actionEvents[0].action.id).toStartWith("amp-tool-");

    const toolResultEvents = interpreter.onStdoutLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "ok",
              is_error: false,
            },
            {
              type: "tool_result",
              content: "bad",
              is_error: true,
            },
          ],
        },
        parent_tool_use_id: "parent-2",
      }),
    );
    expect(toolResultEvents).toHaveLength(2);
    expect(toolResultEvents[0]).toMatchObject({
      type: "action",
      phase: "completed",
      ok: true,
      message: "ok",
      action: { id: "tool-1", title: "tool result" },
      level: "info",
    });
    expect(toolResultEvents[1]).toMatchObject({
      ok: false,
      message: "bad",
      level: "warning",
    });
    expect(toolResultEvents[1].action.id).toStartWith("amp-tool-");

    expect(
      interpreter.onStdoutLine(
        JSON.stringify({
          type: "result",
          is_error: false,
          result: "fallback",
          usage: { inputTokens: 1 },
        }),
      ),
    ).toEqual([
      {
        type: "completed",
        engine: "amp",
        ok: true,
        answer: "Final answer",
        error: undefined,
        resume: "amp-session",
        usage: { inputTokens: 1 },
      },
    ]);
    expect(interpreter.onStdoutLine(JSON.stringify({ type: "result" }))).toEqual([]);
    expect(interpreter.onExit({ exitCode: 2, stderr: "late failure\n" })).toEqual([]);
  });

  test("interprets result errors and process exits", () => {
    const failed = new AmpAgent().createOutputInterpreter();
    expect(
      failed.onStdoutLine(
        JSON.stringify({
          type: "result",
          is_error: true,
          result: "partial",
          error: "amp failed",
          session_id: "failed-session",
        }),
      ),
    ).toEqual([
      {
        type: "completed",
        engine: "amp",
        ok: false,
        answer: "partial",
        error: "amp failed",
        resume: "failed-session",
        usage: undefined,
      },
    ]);

    const exited = new AmpAgent().createOutputInterpreter();
    expect(exited.onExit({ exitCode: 0, stderr: "" })).toEqual([]);
    expect(
      exited.onStdoutLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "draft" }] },
        }),
      ),
    ).toEqual([]);
    expect(exited.onExit({ exitCode: 9, stderr: "boom\n" })).toEqual([
      {
        type: "completed",
        engine: "amp",
        ok: false,
        answer: "draft",
        error: "boom",
        resume: undefined,
      },
    ]);

    const fallbackExit = new AmpAgent().createOutputInterpreter();
    expect(fallbackExit.onExit({ exitCode: 3, stderr: "" })[0].error).toBe("Amp exited with code 3");
  });

  test("continues an existing thread when a session id is provided", async () => {
    const agent = new AmpAgent({ visibility: "private" });
    const command = await agent.buildCommand({
      cwd: "/tmp/project",
      prompt: "Keep going",
      options: { resumeSession: "thread-123" },
    });

    // Resume routes through `amp threads continue <id>` at the front of the args.
    expect(command.args.slice(0, 3)).toEqual(["threads", "continue", "thread-123"]);
    expect(command.args).toContain("--execute");
    // New-thread-only flags are not emitted when continuing a thread.
    expect(command.args).not.toContain("--visibility");
    expect(command.args).not.toContain("--archive");
  });

  test("starts a fresh thread (no continue) when no session id is provided", async () => {
    const agent = new AmpAgent({ visibility: "private" });
    const command = await agent.buildCommand({ cwd: "/tmp/project", prompt: "Start" });

    expect(command.args).not.toContain("continue");
    expect(command.args).toContain("--archive");
    expect(command.args).toContain("--visibility");
  });
});
