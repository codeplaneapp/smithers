import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSmithers, Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";

const PiOutput = z.object({ answer: z.string() });
const ClaudeOutput = z.object({ answer: z.string() });
const CodexOutput = z.object({ answer: z.string() });
const GeminiOutput = z.object({ answer: z.string() });
const SdkOutput = z.object({ answer: z.string() });

const { smithers, outputs } = createSmithers(
  {
    piResult: PiOutput,
    claudeResult: ClaudeOutput,
    codexResult: CodexOutput,
    geminiResult: GeminiOutput,
    sdkResult: SdkOutput,
  },
  {
    dbPath: "./workflows/agent-trace-otel-demo.db",
    journalMode: "DELETE",
  },
);

function writeDemoSessionFile(path: string, rows: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

function createPiDemoAgent(failureMode?: string) {
  const sessionDir = join(tmpdir(), "smithers-agent-session-demo", "pi");
  const sessionId = "demo-session";
  writeDemoSessionFile(
    join(sessionDir, `2026-05-10T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", id: sessionId, cwd: process.cwd() },
      { type: "model_change", modelId: "demo-pi" },
      { type: "thinking_level_change", thinkingLevel: "medium" },
    ],
  );
  return {
    id: failureMode ? `pi-observability-demo-${failureMode}` : "pi-observability-demo",
    model: "demo-pi",
    opts: { mode: "json", sessionDir },
    generate: async (args: { onStdout?: (text: string) => void }) => {
      if (failureMode === "malformed-json") {
        args.onStdout?.("{not valid json}\n");
        throw new Error("demo malformed-json failure");
      }
      args.onStdout?.(JSON.stringify({ type: "session", id: "demo-session" }) + "\n");
      args.onStdout?.(JSON.stringify({ type: "turn_start", id: "turn-1" }) + "\n");
      args.onStdout?.(
        JSON.stringify({
          type: "message_start",
          message: { role: "assistant", content: [] },
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "Planning demo work with token=sk_demo_secret_123456789",
          },
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Working through the repository. ",
          },
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "tool_execution_start",
          toolExecution: {
            id: "tool-1",
            name: "bash",
            args: { command: "echo hi" },
          },
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "tool_execution_update",
          toolExecution: {
            id: "tool-1",
            name: "bash",
            result: { status: "running" },
          },
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "tool_execution_end",
          toolExecution: {
            id: "tool-1",
            name: "bash",
            result: { ok: true },
          },
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Demo PI answer" }],
            usage: { inputTokens: 11, outputTokens: 7 },
          },
        }) + "\n",
      );
      args.onStdout?.(JSON.stringify({ type: "agent_end", id: "demo-session" }) + "\n");
      return {
        text: '{"answer":"Demo PI answer"}',
        output: { answer: "Demo PI answer" },
        usage: { inputTokens: 11, outputTokens: 7 },
      };
    },
  } as any;
}

function createClaudeDemoAgent() {
  const sessionRoot = join(tmpdir(), "smithers-agent-session-demo", "claude");
  const sessionId = "claude-demo-session";
  writeDemoSessionFile(
    join(
      sessionRoot,
      process.cwd().replace(/[\\/]/g, "-"),
      `${sessionId}.jsonl`,
    ),
    [
      {
        type: "queue-operation",
        operation: "enqueue",
        sessionId,
        content: "Emit a Claude-like structured trace",
      },
      {
        type: "progress",
        sessionId,
        data: { type: "hook_progress", hookEvent: "SessionStart" },
      },
      {
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Claude planning demo work" }],
        },
      },
    ],
  );
  return {
    id: "claude-observability-demo",
    model: "demo-claude",
    opts: { outputFormat: "stream-json", claudeProjectsDir: sessionRoot },
    generate: async (args: { onStdout?: (text: string) => void }) => {
      args.onStdout?.(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "claude-demo-session",
          model: "claude-opus-demo",
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Claude demo answer" }],
            usage: {
              input_tokens: 13,
              cache_read_input_tokens: 2,
              output_tokens: 5,
            },
          },
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Claude demo answer",
          usage: {
            input_tokens: 13,
            cache_read_input_tokens: 2,
            output_tokens: 5,
          },
        }) + "\n",
      );
      return {
        text: '{"answer":"Claude demo answer"}',
        output: { answer: "Claude demo answer" },
      };
    },
  } as any;
}

function createGeminiDemoAgent() {
  return {
    id: "gemini-observability-demo",
    model: "demo-gemini",
    opts: { outputFormat: "stream-json" },
    generate: async (args: { onStdout?: (text: string) => void }) => {
      args.onStdout?.(
        JSON.stringify({
          type: "init",
          session_id: "gemini-demo-session",
          model: "gemini-demo",
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Gemini ",
          delta: true,
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: "demo answer",
          delta: true,
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "result",
          status: "success",
          stats: {
            input_tokens: 9,
            output_tokens: 4,
            total_tokens: 13,
          },
        }) + "\n",
      );
      return {
        text: '{"answer":"Gemini demo answer"}',
        output: { answer: "Gemini demo answer" },
      };
    },
  } as any;
}

function createCodexDemoAgent() {
  const sessionRoot = join(tmpdir(), "smithers-agent-session-demo", "codex");
  const now = new Date();
  writeDemoSessionFile(
    join(
      sessionRoot,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      "rollout-demo.jsonl",
    ),
    [
      {
        type: "session_meta",
        payload: {
          id: "codex-demo-session",
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "agent_reasoning",
          text: "Codex demo reasoning about the repository",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"pwd"}',
        },
      },
    ],
  );
  return {
    id: "codex-observability-demo",
    model: "demo-codex",
    opts: { outputFormat: "stream-json", json: true, sessionDir: sessionRoot },
    generate: async (args: { onStdout?: (text: string) => void }) => {
      args.onStdout?.(
        JSON.stringify({
          type: "thread.started",
          thread_id: "codex-demo-thread",
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "assistant_message.delta",
          delta: { text: "Codex demo answer" },
        }) + "\n",
      );
      args.onStdout?.(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 12, output_tokens: 6 },
          message: { role: "assistant", content: "Codex demo answer" },
        }) + "\n",
      );
      return {
        text: '{"answer":"Codex demo answer"}',
        output: { answer: "Codex demo answer" },
      };
    },
  } as any;
}

class OpenAIAgentDemo {
  id = "openai-demo-agent";
  model = "demo-sdk";
  tools = {};

  async generate() {
    return {
      text: '{"answer":"Demo SDK answer"}',
      output: { answer: "Demo SDK answer" },
      usage: { inputTokens: 5, outputTokens: 3 },
    };
  }
}

export default smithers((ctx) => {
  const input = ctx.input as { failureMode?: string };
  const failureMode = typeof input.failureMode === "string" ? input.failureMode : undefined;
  const piAgent = createPiDemoAgent(failureMode);

  return (
    <Workflow name="agent-trace-otel-demo">
      <Task id="pi-rich-trace" output={outputs.piResult} agent={piAgent} retries={0}>
        {`Emit a PI-like trace for observability verification. failureMode=${failureMode ?? "none"}`}
      </Task>
      {!failureMode && (
        <>
          <Task
            id="claude-structured-trace"
            output={outputs.claudeResult}
            agent={createClaudeDemoAgent()}
          >
            {`Emit a Claude-like structured trace after the PI demo task completes.`}
          </Task>
          <Task
            id="gemini-structured-trace"
            output={outputs.geminiResult}
            agent={createGeminiDemoAgent()}
          >
            {`Emit a Gemini-like structured trace after the Claude demo task completes.`}
          </Task>
          <Task
            id="codex-structured-trace"
            output={outputs.codexResult}
            agent={createCodexDemoAgent()}
          >
            {`Emit a Codex-like structured trace after the Gemini demo task completes.`}
          </Task>
          <Task id="sdk-final-only" output={outputs.sdkResult} agent={new OpenAIAgentDemo() as any}>
            {`Return a final-only SDK response after the structured PI, Claude, Gemini, and Codex demo tasks complete.`}
          </Task>
        </>
      )}
    </Workflow>
  );
});
