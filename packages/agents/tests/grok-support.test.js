import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { GrokAgent } from "../src/index.js";
import { makeFakeNodeCli, prependPath } from "./fake-cli.js";

const originalPath = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.GROK_ARGS_FILE;
});

describe("GrokAgent", () => {
  test("builds the official headless streaming command and keeps credentials out of argv", async () => {
    const secret = "xai-secret-value";
    const agent = new GrokAgent({
      configDir: "/tmp/grok-home",
      apiKey: secret,
      model: "test-model",
      effort: "high",
      tools: ["read_file", "grep"],
      disallowedTools: ["run_terminal_cmd"],
      maxTurns: 4,
    });
    const spec = await agent.buildCommand({
      prompt: "inspect",
      systemPrompt: "be careful",
      cwd: "/tmp/project",
      options: { resumeSession: "session-1" },
    });

    expect(spec.command).toBe("grok");
    expect(spec.args).toEqual(
      expect.arrayContaining([
        "--no-auto-update",
        "--cwd",
        "/tmp/project",
        "--output-format",
        "streaming-json",
        "--model",
        "test-model",
        "--effort",
        "high",
        "--resume",
        "session-1",
        "-p",
        "inspect",
      ]),
    );
    expect(spec.args.join(" ")).not.toContain(secret);
    expect(spec.env).toEqual({ GROK_HOME: "/tmp/grok-home", XAI_API_KEY: secret });
    expect(agent.supportsNativeStructuredOutput).toBe(true);
  });

  test("passes task schemas through Grok's native --json-schema flag", async () => {
    const agent = new GrokAgent();
    const spec = await agent.buildCommand({
      prompt: "inspect",
      cwd: "/tmp/project",
      options: { outputSchema: z.object({ result: z.string() }) },
    });
    const schema = JSON.parse(spec.args[spec.args.indexOf("--json-schema") + 1]);
    expect(schema).toMatchObject({ type: "object", required: ["result"] });
  });

  test("parses streaming text, tool lifecycle, usage, and terminal session id", () => {
    const interpreter = new GrokAgent({ model: "test-model" }).createOutputInterpreter();
    const tool = interpreter.onStdoutLine(
      JSON.stringify({
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "read_file",
        title: "Read",
        status: "in_progress",
        rawInput: { path: "README.md" },
      }),
    );
    expect(tool[0]).toMatchObject({ type: "started", engine: "grok" });
    expect(tool[1]).toMatchObject({ type: "action", phase: "started", action: { id: "call-1" } });
    expect(
      interpreter.onStdoutLine(
        JSON.stringify({ type: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: "ok" }),
      )[0],
    ).toMatchObject({ type: "action", phase: "completed", ok: true });
    expect(interpreter.onStdoutLine(JSON.stringify({ type: "text", data: "done" }))[0]).toMatchObject({
      type: "action",
      phase: "updated",
      entryType: "message",
      message: "done",
    });
    interpreter.onStdoutLine(JSON.stringify({ type: "usage", usage: { input_tokens: 2, output_tokens: 1 } }));
    expect(
      interpreter.onStdoutLine(JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "session-2" }))[0],
    ).toMatchObject({
      type: "completed",
      engine: "grok",
      ok: true,
      answer: "done",
      resume: "session-2",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  });

  test("uses the schema-validated terminal payload as the final answer", () => {
    const interpreter = new GrokAgent().createOutputInterpreter();
    const events = interpreter.onStdoutLine(
      JSON.stringify({ type: "end", sessionId: "session-3", structuredOutput: { result: "ok" } }),
    );
    expect(events.at(-1)).toMatchObject({ type: "completed", ok: true, answer: '{"result":"ok"}' });
  });

  test("runs against a fake binary and surfaces terminal errors without leaking the API key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-grok-test-"));
    const argsFile = join(dir, "args.json");
    const fake = await makeFakeNodeCli(
      dir,
      "grok",
      `
const fs = require("node:fs");
fs.writeFileSync(process.env.GROK_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "error", message: "Too many requests; retry after 60 seconds" }) + "\\n");
process.exit(1);
`,
    );
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      process.env.GROK_ARGS_FILE = argsFile;
      const secret = "xai-never-in-argv";
      const agent = new GrokAgent({ env: { PATH: process.env.PATH }, apiKey: secret, model: "test-model" });
      await expect(agent.generate({ prompt: "work" })).rejects.toMatchObject({ code: "AGENT_QUOTA_EXCEEDED" });
      expect(JSON.parse(await readFile(argsFile, "utf8")).join(" ")).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("redacts the configured API key from vendor-controlled events", () => {
    const secret = "xai-secret-never-persist";
    const interpreter = new GrokAgent({ apiKey: secret }).createOutputInterpreter();
    interpreter.onStdoutLine(JSON.stringify({ type: "text", data: `failure: ${secret}` }));
    const errorEvents = interpreter.onStdoutLine(
      JSON.stringify({ type: "error", message: `authentication failed for ${secret}` }),
    );
    expect(errorEvents).toEqual([]);
    const [terminal] = interpreter.onExit({ exitCode: 1, stderr: "", stdout: "" });
    expect(JSON.stringify(terminal)).not.toContain(secret);
    expect(terminal).toMatchObject({ error: "authentication failed for [REDACTED]" });
  });
});
