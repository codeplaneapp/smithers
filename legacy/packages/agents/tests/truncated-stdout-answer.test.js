import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeAgent } from "../src/index.js";

/**
 * Regression tests for https://github.com/smithersai/smithers/issues/277
 *
 * Long CLI-agent runs overflow the captured-stdout cap. The capture used to
 * keep the HEAD of the stream, dropping the terminal `result` event with the
 * real answer; text extraction then fell back to tool-result junk and the
 * engine's context-free JSON repair persisted amnesiac output. The live
 * interpreter parses the stream before the cap applies, so its completed
 * answer (and usage) must survive truncation.
 */

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
 * Fake `claude` CLI emitting stream-json: `noiseBytes` of filler lines the
 * interpreter ignores, then a terminal result event carrying the answer.
 *
 * @param {{ noiseBytes: number; answer: string }} config
 */
async function makeFakeClaude(config) {
  const dir = await mkdtemp(join(tmpdir(), "smithers-truncation-test-"));
  cleanups.push(dir);
  const binPath = join(dir, "claude");
  const script = [
    "#!/usr/bin/env node",
    `const noiseLine = JSON.stringify({ type: "system", subtype: "noise", data: "x".repeat(2000) });`,
    `let written = 0;`,
    `while (written < ${config.noiseBytes}) {`,
    `  process.stdout.write(noiseLine + "\\n");`,
    `  written += noiseLine.length + 1;`,
    `}`,
    `process.stdout.write(JSON.stringify({`,
    `  type: "result",`,
    `  subtype: "success",`,
    `  is_error: false,`,
    `  result: ${JSON.stringify(config.answer)},`,
    `  session_id: "test-session",`,
    `  usage: { input_tokens: 1234, output_tokens: 56 },`,
    `}) + "\\n");`,
    "",
  ].join("\n");
  await writeFile(binPath, script, "utf8");
  await chmod(binPath, 0o755);
  return dir;
}

describe("issue #277 — answers survive captured-stdout truncation", () => {
  test("answer survives when noise overflows the cap and the result line fits in the kept tail", async () => {
    const answer = JSON.stringify({ issueNumber: 277, summary: "the real answer" });
    const dir = await makeFakeClaude({ noiseBytes: 60_000, answer });
    process.env.PATH = `${dir}:${originalPath}`;
    const agent = new ClaudeCodeAgent({ model: "claude-test", maxOutputBytes: 10_000 });
    const result = await agent.generate({ prompt: "investigate" });
    expect(result.text).toBe(answer);
    expect(result.output ?? null).toBeTruthy();
  }, 30_000);

  test("answer survives even when the result line itself exceeds the cap (streamed interpreter answer wins)", async () => {
    const answer = JSON.stringify({ issueNumber: 277, payload: "y".repeat(8_000) });
    const dir = await makeFakeClaude({ noiseBytes: 20_000, answer });
    process.env.PATH = `${dir}:${originalPath}`;
    const agent = new ClaudeCodeAgent({ model: "claude-test", maxOutputBytes: 4_000 });
    const result = await agent.generate({ prompt: "investigate" });
    expect(result.text).toBe(answer);
  }, 30_000);

  test("usage from the completed event survives truncation that drops the per-message usage lines", async () => {
    const answer = "plain answer";
    const dir = await makeFakeClaude({ noiseBytes: 60_000, answer });
    process.env.PATH = `${dir}:${originalPath}`;
    const agent = new ClaudeCodeAgent({ model: "claude-test", maxOutputBytes: 4_000 });
    const result = await agent.generate({ prompt: "investigate" });
    expect(result.text).toBe(answer);
    expect(result.usage?.inputTokens).toBe(1234);
    expect(result.usage?.outputTokens).toBe(56);
  }, 30_000);
});
