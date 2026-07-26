import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Effect } from "effect";
import { OmpAgent } from "../src/OmpAgent.js";
import { PiAgent } from "../src/PiAgent.js";
import { runRpcCommandEffect } from "../src/BaseCliAgent/runRpcCommandEffect.js";
import { sanitizeCliArgs } from "../src/BaseCliAgent/sanitizeCliArgs.js";

describe("OmpAgent", () => {
  test("redacts split and equals-form sensitive arguments", () => {
    const safe = sanitizeCliArgs(["--api-key", "opaque-secret", "--api-key=another-secret", "--model", "m"]);
    expect(safe).toEqual(["--api-key", "[REDACTED]", "--api-key=[REDACTED]", "--model", "m"]);
    expect(safe.join(" ")).not.toContain("secret");
  });
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
      "--print", "--mode", "json", "--model", "m", "--provider", "p",
      "--system-prompt", "s", "--cwd", "/repo", "--resume", "session-id", "--session-dir", "/sessions",
      "--tools", "read,edit", "--extension", "ext.js", "--skills", "skill-a,skill-b", "--thinking", "high",
      "--hide-thinking", "--print-thoughts", "--hook", "hook.js", "--max-time", "30", "--auto-approve", "hello",
    ]);
    expect(args).not.toContain("--session");
    expect(args).not.toContain("--skill");
    expect(args).not.toContain("--list-models");
  });

  test("delivers an explicit provider key through env without mutating options or argv", async () => {
    const opts = { mode: "json", provider: "openai", model: "gpt-5.2", apiKey: "omp-secret", env: { OPENAI_API_KEY: "inherited" } };
    const agent = new OmpAgent(opts);
    const command = await agent.buildCommand({ prompt: "hello", cwd: "/repo", options: {} });
    expect(command.args).not.toContain("--api-key");
    expect(command.args.join(" ")).not.toContain("omp-secret");
    expect(command.env).toEqual({ OPENAI_API_KEY: "omp-secret" });
    expect(opts).toEqual({ mode: "json", provider: "openai", model: "gpt-5.2", apiKey: "omp-secret", env: { OPENAI_API_KEY: "inherited" } });
  });

  test("routes an explicit provider before model-family aliases", async () => {
    await expect(new OmpAgent({ provider: "openrouter", model: "anthropic/claude-opus-4.6", apiKey: "secret" }).buildCommand({ prompt: "", cwd: "/repo", options: {} })).resolves.toMatchObject({ env: { OPENROUTER_API_KEY: "secret" } });
    await expect(new OmpAgent({ provider: "google", model: "gpt-5", apiKey: "secret" }).buildCommand({ prompt: "", cwd: "/repo", options: {} })).resolves.toMatchObject({ env: { GEMINI_API_KEY: "secret" } });
  });

  test("supports documented OMP provider credential environments and explicit precedence", async () => {
    for (const [provider, envName] of [["fireworks", "FIREWORKS_API_KEY"], ["together", "TOGETHER_API_KEY"], ["huggingface", "HF_TOKEN"], ["nvidia", "NVIDIA_API_KEY"], ["litellm", "LITELLM_API_KEY"], ["qianfan", "QIANFAN_API_KEY"]]) {
      const command = await new OmpAgent({ provider, apiKey: "explicit-key", env: { [envName]: "stored-key" } }).buildCommand({ prompt: "", cwd: "/repo", options: {} });
      expect(command.env?.[envName]).toBe("explicit-key");
    }
  });

  test("fails closed for an explicit key without a safe provider mapping", async () => {
    const agent = new OmpAgent({ provider: "unknown-provider", apiKey: "omp-secret" });
    await expect(agent.buildCommand({ prompt: "hello", cwd: "/repo", options: {} })).rejects.toThrow("documented provider");
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

  test("preserves tool call args on start and update like the pi interpreter", () => {
    const interpreter = new OmpAgent({ mode: "json" }).createOutputInterpreter();
    const args = { op: "init", list: [{ phase: "Investigate", items: ["Map files"] }] };
    const actionsFor = (payload) => interpreter.onStdoutLine(JSON.stringify(payload)).filter((event) => event.type === "action");
    expect(actionsFor({ type: "tool_execution_start", toolName: "todo", toolCallId: "t1", args }).at(-1)?.action).toEqual({ id: "t1", kind: "todo_list", title: "todo", detail: { args } });
    expect(actionsFor({ type: "tool_execution_update", toolName: "todo", toolCallId: "t1", args: { op: "start", task: "Map files" } }).at(-1)?.action.detail).toEqual({ args: { op: "start", task: "Map files" } });
    expect(actionsFor({ type: "tool_execution_end", toolName: "todo", toolCallId: "t1", result: "ok" }).at(-1)?.action.detail).toBeUndefined();
  });

  test("emits the same tool-call args detail as the pi interpreter", () => {
    const omp = new OmpAgent({ mode: "json" }).createOutputInterpreter();
    const pi = new PiAgent({ mode: "json" }).createOutputInterpreter();
    const argsFor = (interpreter, payload) => interpreter.onStdoutLine(JSON.stringify(payload)).findLast((event) => event.type === "action")?.action?.detail?.args;
    for (const args of [{ op: "init", list: [{ phase: "Investigate", items: ["Map files"] }] }, { op: "start", task: "Map files" }]) {
      for (const type of ["tool_execution_start", "tool_execution_update"]) {
        const payload = { type, toolName: "todo", toolCallId: "t1", args };
        const [ompArgs, piArgs] = [argsFor(omp, payload), argsFor(pi, payload)];
        expect(ompArgs).toEqual(args);
        expect(ompArgs).toEqual(piArgs);
      }
    }
    const end = { type: "tool_execution_end", toolName: "todo", toolCallId: "t1", result: "ok" };
    expect(argsFor(omp, end)).toBeUndefined();
    expect(argsFor(pi, end)).toBeUndefined();
  });

  test("uses a terminal-only assistant message as the authoritative JSON answer once", () => {
    const interpreter = new OmpAgent({ mode: "json" }).createOutputInterpreter();
    const terminal = JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: "terminal answer", stopReason: "stop" }] });
    expect(interpreter.onStdoutLine(terminal).at(-1)).toMatchObject({ type: "completed", ok: true, answer: "terminal answer" });
    expect(interpreter.onStdoutLine(terminal)).toEqual([]);
  });

  test("selects the last assistant message from a terminal JSON event", () => {
    const interpreter = new OmpAgent({ mode: "json" }).createOutputInterpreter();
    const event = interpreter.onStdoutLine(JSON.stringify({ type: "agent_end", messages: [
      { role: "assistant", content: "intermediate", stopReason: "tool_use" },
      { role: "tool", content: "result" },
      { role: "assistant", content: "final answer", stopReason: "stop" },
    ] }));
    expect(event.at(-1)).toMatchObject({ type: "completed", answer: "final answer" });
  });

  test("completes a zero-delta RPC agent_end with the last assistant answer", async () => {
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
          stdout.write(JSON.stringify({ type: "agent_end", messages: [
            { role: "assistant", content: "intermediate", stopReason: "tool_use" },
            { role: "tool", content: "done" },
            { role: "assistant", content: "terminal rpc answer", stopReason: "stop" },
          ] }) + "\n");
        }
      }
    });
    queueMicrotask(() => stdout.write('{"type":"ready"}\n'));
    const result = await Effect.runPromise(runRpcCommandEffect("omp", [], {
      cwd: process.cwd(), env: process.env, prompt: "say hello", spawnFn: () => child,
    }));
    expect(result.text).toBe("terminal rpc answer");
    expect(result.output).toMatchObject({ content: "terminal rpc answer" });
    expect(commands.map((command) => command.type)).toEqual(["get_state", "prompt"]);
  });

  test("redacts sensitive RPC args in persisted failure details", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin: new PassThrough(), pid: undefined, exitCode: null, unref() {} });
    const pending = Effect.runPromise(runRpcCommandEffect("omp", ["--api-key", "opaque-canary", "--token=another-canary"], {
      cwd: process.cwd(), env: process.env, prompt: "fail", spawnFn: () => child,
    }));
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    try { await pending; } catch (error) {
      expect(JSON.stringify(error)).toContain("[REDACTED]");
      expect(JSON.stringify(error)).not.toContain("opaque-canary");
      expect(JSON.stringify(error)).not.toContain("another-canary");
    }
  });

  test("redacts real spawn error spawnargs", async () => {
    try {
      await Effect.runPromise(runRpcCommandEffect("definitely-not-an-omp-command", ["--api-key", "opaque-spawn-canary"], {
        cwd: process.cwd(), env: process.env, prompt: "fail",
      }));
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain("opaque-spawn-canary");
      expect(serialized).not.toContain("spawnargs");
    }
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
