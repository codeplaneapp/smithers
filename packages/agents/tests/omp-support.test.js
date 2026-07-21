import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Effect } from "effect";
import { OmpAgent } from "../src/OmpAgent.js";
import { runRpcCommandEffect } from "../src/BaseCliAgent/runRpcCommandEffect.js";

describe("OmpAgent", () => {
  test("constructs only OMP v17 flags and values resume over continue", () => {
    const agent = new OmpAgent({
      mode: "json", model: "m", provider: "p", apiKey: "k", systemPrompt: "s",
      continueSession: true, resume: "session-id", sessionDir: "/sessions",
      tools: ["read", "edit"], extensions: ["ext.js"], skills: ["skill-a", "skill-b"],
      thinking: "high", hideThinking: true, printThoughts: true, hooks: ["hook.js"],
      maxTime: 30, autoApprove: true,
    });
    const args = agent.buildArgs({ prompt: "hello", cwd: "/repo", options: {}, mode: "json" });
    expect(args).toEqual([
      "--print", "--mode", "json", "--model", "m", "--provider", "p", "--api-key", "k",
      "--system-prompt", "s", "--cwd", "/repo", "--resume", "session-id", "--session-dir", "/sessions",
      "--tools", "read,edit", "--extension", "ext.js", "--skills", "skill-a,skill-b", "--thinking", "high",
      "--hide-thinking", "--print-thoughts", "--hook", "hook.js", "--max-time", "30", "--auto-approve", "hello",
    ]);
    expect(args).not.toContain("--session");
    expect(args).not.toContain("--skill");
    expect(args).not.toContain("--list-models");
  });

  test("supports all documented thinking levels and never appends a CLI prompt in RPC mode", () => {
    for (const thinking of ["max", "auto"]) {
      const agent = new OmpAgent({ mode: "rpc", thinking });
      expect(agent.buildArgs({ prompt: "rpc prompt", cwd: "/repo", options: {}, mode: "rpc" })).toEqual(["--mode", "rpc", "--cwd", "/repo", "--thinking", thinking]);
    }
  });

  test("exposes the RPC command spec required by Smithers preflight", async () => {
    const agent = new OmpAgent({ mode: "rpc", noSession: true, noTools: true });
    await expect(agent.buildCommand({
      prompt: "",
      cwd: "/repo",
      options: {},
    })).resolves.toEqual({
      command: "omp",
      args: ["--mode", "rpc", "--cwd", "/repo", "--no-session", "--no-tools"],
      outputFormat: "rpc",
    });
  });

  test("interprets OMP JSON session, text, tool, and completion events", () => {
    const agent = new OmpAgent({ mode: "json" });
    const interpreter = agent.createOutputInterpreter();
    const events = [
      ...interpreter.onStdoutLine(JSON.stringify({ type: "session", id: "s1" })),
      ...interpreter.onStdoutLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK" } })),
      ...interpreter.onStdoutLine(JSON.stringify({ type: "tool_execution_start", toolName: "read", toolCallId: "t1" })),
      ...interpreter.onStdoutLine(JSON.stringify({ type: "tool_execution_end", toolName: "read", toolCallId: "t1", result: "done" })),
      ...interpreter.onStdoutLine(JSON.stringify({ type: "agent_end" })),
    ];
    expect(events.map((event) => event.type)).toEqual(["started", "action", "action", "action", "completed"]);
    expect(events.at(-1)).toMatchObject({ ok: true, answer: "OK", resume: "s1" });
  });

  test("completes documented RPC agent_end without an assistant message and captures get_state session", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      pid: undefined,
      exitCode: 0,
      unref() {},
    });
    const commands = [];
    stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (!line) continue;
        const command = JSON.parse(line);
        commands.push(command);
        if (command.type === "get_state") {
          stdout.write(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionId: "rpc-session" } }) + "\n");
        }
        if (command.type === "prompt") {
          stdout.write(JSON.stringify({ type: "response", command: "prompt", id: command.id, success: true, data: { agentInvoked: true } }) + "\n");
          stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } }) + "\n");
          stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\n");
        }
      }
    });
    queueMicrotask(() => stdout.write('{"type":"ready"}\n'));
    const result = await Effect.runPromise(runRpcCommandEffect("omp", [], {
      cwd: process.cwd(), env: process.env, prompt: "say hello", spawnFn: () => child,
    }));
    expect(result.text).toBe("hello");
    expect(commands.map((command) => command.type)).toEqual(["get_state", "prompt"]);
  });

  test("sends the documented RPC abort command before forced cleanup", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: undefined, exitCode: null, unref() {} });
    const commands = [];
    stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) if (line) commands.push(JSON.parse(line));
    });
    queueMicrotask(() => stdout.write('{"type":"ready"}\n'));
    const controller = new AbortController();
    const pending = Effect.runPromise(runRpcCommandEffect("omp", [], {
      cwd: process.cwd(), env: process.env, prompt: "wait", spawnFn: () => child, signal: controller.signal,
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toThrow("CLI aborted");
    expect(commands.at(-1)?.type).toBe("abort");
  });
});
