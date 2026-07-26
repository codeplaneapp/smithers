import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";
import { CodexAgent } from "../src/CodexAgent.js";
import { KimiAgent } from "../src/KimiAgent.js";

const originalKimiShareDir = process.env.KIMI_SHARE_DIR;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  if (originalKimiShareDir === undefined) {
    delete process.env.KIMI_SHARE_DIR;
  } else {
    process.env.KIMI_SHARE_DIR = originalKimiShareDir;
  }
});

describe("KimiAgent share-dir isolation", () => {
  test("copies inherited share metadata into an isolated per-invocation dir and cleans it up", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "smithers-kimi-source-"));
    await writeFile(join(sourceDir, "config.toml"), "model = 'kimi-test'\n", "utf8");
    await writeFile(join(sourceDir, "device_id"), "device-123\n", "utf8");
    process.env.KIMI_SHARE_DIR = sourceDir;

    const command = await new KimiAgent({ outputFormat: "text" }).buildCommand({
      cwd: "/tmp/project",
      prompt: "hello",
      options: {},
    });
    const isolatedDir = command.env?.KIMI_SHARE_DIR;

    try {
      expect(typeof isolatedDir).toBe("string");
      expect(isolatedDir).not.toBe(sourceDir);
      expect(command.args).toContain("--final-message-only");
      expect(await readFile(join(isolatedDir, "config.toml"), "utf8")).toBe("model = 'kimi-test'\n");
      expect(await readFile(join(isolatedDir, "device_id"), "utf8")).toBe("device-123\n");
    } finally {
      await command.cleanup?.();
      await rm(sourceDir, { recursive: true, force: true });
    }

    expect(await exists(isolatedDir)).toBe(false);
  });

  test("uses configDir directly and switches event runs to stream-json without final-message-only", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "smithers-kimi-config-"));
    const inheritedDir = await mkdtemp(join(tmpdir(), "smithers-kimi-inherited-"));
    process.env.KIMI_SHARE_DIR = inheritedDir;

    const command = await new KimiAgent({ configDir }).buildCommand({
      cwd: "/tmp/project",
      prompt: "REQUIRED OUTPUT\nReturn the JSON object.",
      options: { onEvent: () => undefined },
    });

    try {
      expect(command.env).toEqual({ KIMI_SHARE_DIR: configDir });
      expect(command.outputFormat).toBe("stream-json");
      expect(
        command.args.slice(command.args.indexOf("--output-format"), command.args.indexOf("--output-format") + 2),
      ).toEqual(["--output-format", "stream-json"]);
      expect(command.args).not.toContain("--final-message-only");
      const prompt = command.args[command.args.indexOf("--prompt") + 1];
      expect(prompt).toContain("REMINDER: Your response MUST be ONLY the required raw JSON object");
    } finally {
      await rm(configDir, { recursive: true, force: true });
      await rm(inheritedDir, { recursive: true, force: true });
    }
  });
});

describe("CodexAgent resume command shape", () => {
  test("does not pass structured-output or new-thread-only flags while resuming", async () => {
    const command = await new CodexAgent({
      nativeStructuredOutput: true,
      outputSchema: "schema.json",
      oss: true,
      localProvider: "ollama",
      sandbox: "workspace-write",
      profile: "default",
      cd: "/tmp/project",
      addDir: ["src"],
      outputLastMessage: "last-message.txt",
    }).buildCommand({
      cwd: "/tmp/project",
      systemPrompt: "system",
      prompt: "continue",
      options: {
        resumeSession: "thread-123",
        outputSchema: { unusedBecauseResume: true },
      },
    });

    expect(command.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(command.args).toContain("--json");
    expect(command.args).toContain("--output-last-message");
    expect(command.args).not.toContain("--output-schema");
    expect(command.args).not.toContain("--oss");
    expect(command.args).not.toContain("--local-provider");
    expect(command.args).not.toContain("--sandbox");
    expect(command.args).not.toContain("--profile");
    expect(command.args).not.toContain("--cd");
    expect(command.args).not.toContain("--add-dir");
    expect(command.args.slice(-2)).toEqual(["thread-123", "-"]);
    expect(command.stdin).toBe("system\n\ncontinue");
    await command.cleanup?.();
  });
});

describe("ClaudeCodeAgent output interpreter", () => {
  test("summarizes bulky read results and suppresses runtime metadata tool output", () => {
    const interpreter = new ClaudeCodeAgent({ model: "claude-test" }).createOutputInterpreter();

    const started = interpreter.onStdoutLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
            { type: "tool_use", id: "meta-1", name: "ListMcpResources", input: {} },
          ],
        },
      }),
    );
    expect(started.map((event) => event.action?.title)).toEqual(["Read", "ListMcpResources"]);

    const readOutput = Array.from({ length: 9 }, (_, index) => `${index + 1}\u2192 line ${index + 1}`).join("\n");
    const readCompleted = interpreter.onStdoutLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "read-1", content: readOutput }],
        },
      }),
    );
    expect(readCompleted[0]).toMatchObject({
      type: "action",
      phase: "completed",
      message: "Read output (9 lines)",
      ok: true,
    });

    const metadataCompleted = interpreter.onStdoutLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "meta-1",
              content: '{"mcp_servers":1,"slash_commands":2,"skills":3}',
            },
          ],
        },
      }),
    );
    expect(metadataCompleted[0].message).toBe("Tool output omitted (runtime metadata).");
  });
});
