import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeKimiWireUsageRecord, kimiWireBaseline, readKimiWireUsageDeltaForHome } from "../src/kimiWireUsage.js";
import { resolveKimiSessionFromIndex, copyKimiSessionState } from "../src/kimiSessionRecovery.js";
import { KimiAgent } from "../src/KimiAgent.js";

const WS = "2b37db29235e4f3b3390565530c3f734";
const SESSION = "ff8c9ea8-6665-41f0-b97a-8ec1dcc62fd5";

/**
 * One real Kimi wire.jsonl usage line, as written by the vendor CLI.
 * @param {Record<string, number>} over
 */
const STATUS_LINE = (over = {}) =>
  JSON.stringify({
    timestamp: 1777166287.7581902,
    message: {
      type: "StatusUpdate",
      payload: {
        context_tokens: 11931,
        token_usage: { input_other: 100, output: 7, input_cache_read: 10, input_cache_creation: 5, ...over },
      },
    },
  });

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("kimi wire usage against the real vendor schema", () => {
  test("normalizes a StatusUpdate token_usage payload", () => {
    expect(
      normalizeKimiWireUsageRecord({
        message: {
          type: "StatusUpdate",
          payload: { token_usage: { input_other: 3, output: 4, input_cache_read: 1, input_cache_creation: 2 } },
        },
      }),
    ).toEqual({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2 });
  });

  test("ignores non-usage wire lines", () => {
    expect(normalizeKimiWireUsageRecord({ type: "metadata", protocol_version: "1.9" })).toBeNull();
    expect(
      normalizeKimiWireUsageRecord({ message: { type: "ContentPart", payload: { type: "text", text: "OK" } } }),
    ).toBeNull();
  });

  test("reads the delta from the per-session wire logs under a home", async () => {
    const home = await tempDir("kimi-home-");
    const sessionDir = join(home, "sessions", WS, SESSION);
    await mkdir(sessionDir, { recursive: true });
    const wire = join(sessionDir, "wire.jsonl");
    await writeFile(wire, `${JSON.stringify({ type: "metadata" })}\n${STATUS_LINE({ output: 999 })}\n`);
    const baseline = kimiWireBaseline(home);
    await appendFile(wire, `${STATUS_LINE({ output: 7 })}\n`);
    const delta = readKimiWireUsageDeltaForHome(home, baseline);
    expect(delta?.usage).toEqual({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 10, cacheWriteTokens: 5 });
  });

  test("counts a wire log created after the baseline in full", async () => {
    const home = await tempDir("kimi-home-");
    const baseline = kimiWireBaseline(home);
    const sessionDir = join(home, "sessions", WS, SESSION);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "wire.jsonl"), `${STATUS_LINE({ output: 21 })}\n`);
    const delta = readKimiWireUsageDeltaForHome(home, baseline);
    expect(delta?.usage.outputTokens).toBe(21);
  });
});

describe("kimi session recovery against the real vendor layout", () => {
  test("resolves the session uuid, not the workspace hash", async () => {
    const home = await tempDir("kimi-home-");
    const sessionDir = join(home, "sessions", WS, SESSION);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "state.json"), "{}\n");
    expect(resolveKimiSessionFromIndex(home)?.sessionId).toBe(SESSION);
  });

  test("copies workspace-scoped session state between homes", async () => {
    const source = await tempDir("kimi-src-");
    const target = await tempDir("kimi-dst-");
    const sessionDir = join(source, "sessions", WS, SESSION);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "context.jsonl"), "prior\n");
    const copied = copyKimiSessionState({ sourceHome: source, targetHome: target, sessionId: SESSION });
    expect(copied?.files).toBe(1);
    expect(await readFile(join(target, "sessions", WS, SESSION, "context.jsonl"), "utf8")).toBe("prior\n");
  });
});

describe("KimiAgent wireUsage default path", () => {
  test("bills the per-session wire log the vendor actually writes", async () => {
    const credentialDir = await tempDir("kimi-creds-");
    const runtimeDir = await tempDir("kimi-runtime-");
    const agent = new KimiAgent({ credentialDir, runtimeDir, wireUsage: true });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      // The CLI creates the session directory after launch, under the
      // workspace hash, and appends its usage there.
      const sessionDir = join(runtimeDir, "sessions", WS, SESSION);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "wire.jsonl"), `${STATUS_LINE({ output: 7 })}\n`);
      const interpreter = agent.createOutputInterpreter();
      const completed = interpreter.onExit({ exitCode: 0, stdout: "", stderr: "" }).find((e) => e.type === "completed");
      expect(completed?.usage).toEqual({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 10, cacheWriteTokens: 5 });
    } finally {
      await command.cleanup?.();
    }
  });

  test("does not re-bill wire usage seeded with resumed session state", async () => {
    const credentialDir = await tempDir("kimi-creds-");
    const runtimeDir = await tempDir("kimi-runtime-");
    const sessionStateDir = await tempDir("kimi-state-");
    const priorDir = join(sessionStateDir, "sessions", WS, SESSION);
    await mkdir(priorDir, { recursive: true });
    await writeFile(join(priorDir, "wire.jsonl"), `${STATUS_LINE({ output: 999 })}\n`);
    const agent = new KimiAgent({
      credentialDir,
      runtimeDir,
      sessionStateDir,
      session: SESSION,
      sessionRecovery: true,
      wireUsage: true,
    });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      // Seeded history is present in the isolated home but predates the baseline.
      expect(await readFile(join(runtimeDir, "sessions", WS, SESSION, "wire.jsonl"), "utf8")).toContain("999");
      await appendFile(join(runtimeDir, "sessions", WS, SESSION, "wire.jsonl"), `${STATUS_LINE({ output: 3 })}\n`);
      const interpreter = agent.createOutputInterpreter();
      const completed = interpreter.onExit({ exitCode: 0, stdout: "", stderr: "" }).find((e) => e.type === "completed");
      expect(completed?.usage?.outputTokens).toBe(3);
    } finally {
      await command.cleanup?.();
    }
  });
});
