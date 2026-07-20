import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentAnswerText } from "../src/BaseCliAgent/BaseCliAgent.js";
import { ClaudeCodeAgent } from "../src/index.js";

/**
 * Regression for the intact (NON-truncated) stream-json extraction path.
 *
 * Claude Code emits NDJSON whose terminal message is a `result` event; there is
 * no `turn_end`/`agent_end`/`finish` line for extractTextFromJsonPayload's
 * reverse-scan to match, so it falls to the chunk-join path and concatenates
 * EVERY assistant turn plus spliced tool-result text. On intact runs the code
 * used that concatenation instead of the interpreter's clean final answer,
 * silently corrupting every stream-json step's output. The selector must prefer
 * the interpreter answer for stream-json whether or not stdout was truncated.
 */

describe("resolveAgentAnswerText — source selection", () => {
  const base = {
    outputFileJson: null,
    outputFileText: undefined,
    streamedAnswer: undefined,
    extractedFromStdout: undefined,
    rawText: "raw",
    stdoutTruncated: false,
    outputFormat: "stream-json",
  };

  test("stream-json intact run prefers the interpreter answer over the noisy concatenation", () => {
    const text = resolveAgentAnswerText({
      ...base,
      streamedAnswer: "the clean answer",
      extractedFromStdout: "Working on it.file1.txtthe clean answerthe clean answer",
      stdoutTruncated: false,
    });
    expect(text).toBe("the clean answer");
  });

  test("stream-json truncated run also prefers the interpreter answer", () => {
    const text = resolveAgentAnswerText({
      ...base,
      streamedAnswer: "the clean answer",
      extractedFromStdout: "partial junk",
      stdoutTruncated: true,
    });
    expect(text).toBe("the clean answer");
  });

  test("stream-json with no interpreter answer falls back to the stdout extraction", () => {
    const text = resolveAgentAnswerText({
      ...base,
      streamedAnswer: undefined,
      extractedFromStdout: "best-effort extraction",
    });
    expect(text).toBe("best-effort extraction");
  });

  test("json format keeps the historical extraction (does NOT prefer the interpreter answer)", () => {
    const text = resolveAgentAnswerText({
      ...base,
      outputFormat: "json",
      streamedAnswer: "interpreter answer",
      extractedFromStdout: "historical extraction",
      stdoutTruncated: false,
    });
    expect(text).toBe("historical extraction");
  });

  test("a JSON output-file wins over everything", () => {
    const text = resolveAgentAnswerText({
      ...base,
      outputFileJson: { ok: true },
      outputFileText: '{"ok":true}',
      streamedAnswer: "interpreter answer",
      extractedFromStdout: "extraction",
    });
    expect(text).toBe('{"ok":true}');
  });

  test("empty stdout extraction falls back to the interpreter answer", () => {
    const text = resolveAgentAnswerText({
      ...base,
      streamedAnswer: "interpreter answer",
      extractedFromStdout: "   ",
      stdoutTruncated: false,
    });
    expect(text).toBe("interpreter answer");
  });
});

const originalPath = process.env.PATH ?? "";
const cleanups = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Fake `claude` CLI emitting a realistic MULTI-TURN stream-json transcript small
 * enough to never hit the capture cap: an assistant text turn, a tool_use, a
 * tool_result, a final assistant text turn, then the terminal `result` event.
 * The naive chunk-join extraction would splice the tool output and duplicate the
 * final text; only the interpreter's `result` answer is clean.
 * @param {string} answer
 */
async function makeMultiTurnClaude(answer) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-intact-streamjson-"));
  cleanups.push(dir);
  const binPath = join(dir, "claude");
  const lines = [
    { type: "system", subtype: "init", session_id: "s" },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look into this." },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "NOISE-FILE-A\nNOISE-FILE-B" }],
      },
    },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
    { type: "result", subtype: "success", is_error: false, result: answer, usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  const script = [
    "#!/usr/bin/env node",
    `const lines = ${JSON.stringify(lines)};`,
    `for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");`,
    "",
  ].join("\n");
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  return dir;
}

describe("intact stream-json runs return the clean interpreter answer", () => {
  test("a multi-turn transcript that fits the cap yields the final answer, not the concatenation", async () => {
    const answer = JSON.stringify({ verdict: "done", detail: "the one true answer" });
    const dir = await makeMultiTurnClaude(answer);
    process.env.PATH = `${dir}:${originalPath}`;
    const agent = new ClaudeCodeAgent({ model: "claude-test" });
    const result = await agent.generate({ prompt: "investigate" });
    expect(result.text).toBe(answer);
    expect(result.text).not.toContain("NOISE-FILE-A");
  }, 30_000);
});
