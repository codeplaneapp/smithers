import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KimiAgent } from "../src/KimiAgent.js";
import { readKimiWireUsageDelta, kimiWireLogPosition, normalizeKimiWireUsageRecord } from "../src/kimiWireUsage.js";
import {
  extractKimiSessionIdFromLine,
  resolveKimiSessionFromIndex,
  copyKimiSessionState,
  isPlausibleKimiSessionId,
} from "../src/kimiSessionRecovery.js";

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

const USAGE_LINE = (over = {}) =>
  JSON.stringify({
    type: "usage.record",
    usage: { cache_read_tokens: 10, cache_write_tokens: 5, other_input_tokens: 100, output_tokens: 7, ...over },
  });

describe("kimiWireUsage", () => {
  test("normalizes a usage.record entry tolerantly", () => {
    expect(
      normalizeKimiWireUsageRecord({
        usage: { cache_read_tokens: 1, cache_write_tokens: 2, other_input_tokens: 3, output_tokens: 4 },
      }),
    ).toEqual({ cacheReadTokens: 1, cacheWriteTokens: 2, inputTokens: 3, outputTokens: 4 });
    expect(
      normalizeKimiWireUsageRecord({ cacheReadTokens: 1, cacheWriteTokens: 2, input_tokens: 3, outputTokens: 4 }),
    ).toEqual({ cacheReadTokens: 1, cacheWriteTokens: 2, inputTokens: 3, outputTokens: 4 });
    expect(normalizeKimiWireUsageRecord({ usage: {} })).toBeNull();
  });

  test("reads only the delta after the baseline offset", async () => {
    const dir = await tempDir("kimi-wire-");
    const file = join(dir, "wire.jsonl");
    await writeFile(file, `${USAGE_LINE()}\n`);
    const baseline = kimiWireLogPosition(file);
    await appendFile(file, `${JSON.stringify({ type: "event", data: 1 })}\n${USAGE_LINE({ output_tokens: 11 })}\n`);
    const delta = readKimiWireUsageDelta(file, baseline);
    expect(delta.entries).toBe(1);
    expect(delta.usage).toEqual({ cacheReadTokens: 10, cacheWriteTokens: 5, inputTokens: 100, outputTokens: 11 });
    // A second pass at the returned offset finds nothing new.
    const again = readKimiWireUsageDelta(file, delta.byteOffset);
    expect(again.entries).toBe(0);
  });

  test("enforces the byte bound and reports truncation", async () => {
    const dir = await tempDir("kimi-wire-");
    const file = join(dir, "wire.jsonl");
    await writeFile(file, `${USAGE_LINE()}\n${USAGE_LINE()}\n`);
    const delta = readKimiWireUsageDelta(file, 0, { maxBytes: 40 });
    expect(delta.truncated).toBe(true);
    expect(delta.entries).toBeLessThan(2);
  });

  test("enforces the entry bound", async () => {
    const dir = await tempDir("kimi-wire-");
    const file = join(dir, "wire.jsonl");
    await writeFile(file, `${USAGE_LINE()}\n${USAGE_LINE()}\n${USAGE_LINE()}\n`);
    const delta = readKimiWireUsageDelta(file, 0, { maxEntries: 2 });
    expect(delta.entries).toBe(2);
    expect(delta.truncated).toBe(true);
  });

  test("returns null for a missing file", async () => {
    expect(readKimiWireUsageDelta(join(await tempDir("kimi-wire-"), "nope.jsonl"), 0)).toBeNull();
  });
});

describe("kimiSessionRecovery", () => {
  test("extracts a session id from CLI output", () => {
    expect(extractKimiSessionIdFromLine("To resume this session: kimi -r abc12345-def6")).toBe("abc12345-def6");
    expect(extractKimiSessionIdFromLine('{"type":"init","session_id":"sess-0001"}')).toBe("sess-0001");
    expect(extractKimiSessionIdFromLine("nothing here")).toBeUndefined();
    expect(extractKimiSessionIdFromLine('{"session":"../evil"}')).toBeUndefined();
  });

  test("validates session ids", () => {
    expect(isPlausibleKimiSessionId("abc12345")).toBe(true);
    expect(isPlausibleKimiSessionId("../etc")).toBe(false);
    expect(isPlausibleKimiSessionId("a/b")).toBe(false);
    expect(isPlausibleKimiSessionId("short")).toBe(false);
  });

  test("resolves the newest session from the on-disk index", async () => {
    const home = await tempDir("kimi-home-");
    await mkdir(join(home, "sessions", "sess-older"), { recursive: true });
    await mkdir(join(home, "sessions", "sess-newer"), { recursive: true });
    // Deterministic ordering: bump mtimes.
    const past = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(join(home, "sessions", "sess-older"), past, past);
    const resolved = resolveKimiSessionFromIndex(home);
    expect(resolved?.sessionId).toBe("sess-newer");
  });

  test("copies session state between homes within bounds", async () => {
    const source = await tempDir("kimi-src-");
    const target = await tempDir("kimi-dst-");
    await mkdir(join(source, "sessions", "sess-0001"), { recursive: true });
    await writeFile(join(source, "sessions", "sess-0001", "history.jsonl"), "line\n");
    const copied = copyKimiSessionState({ sourceHome: source, targetHome: target, sessionId: "sess-0001" });
    expect(copied?.files).toBe(1);
    expect(await readFile(join(target, "sessions", "sess-0001", "history.jsonl"), "utf8")).toBe("line\n");
  });

  test("refuses to copy oversized session state", async () => {
    const source = await tempDir("kimi-src-");
    const target = await tempDir("kimi-dst-");
    await mkdir(join(source, "sessions", "sess-0001"), { recursive: true });
    await writeFile(join(source, "sessions", "sess-0001", "big.bin"), "x".repeat(1024));
    expect(() =>
      copyKimiSessionState({ sourceHome: source, targetHome: target, sessionId: "sess-0001" }, { maxBytes: 10 }),
    ).toThrow(/byte bound/);
  });
});

describe("KimiAgent credential/runtime home separation", () => {
  test("credentialDir seeds an isolated runtime home instead of sharing it live", async () => {
    const credentialDir = await tempDir("kimi-creds-");
    await mkdir(join(credentialDir, "credentials"), { recursive: true });
    await writeFile(join(credentialDir, "credentials", "token.json"), JSON.stringify({ api_key: "k" }));
    await writeFile(join(credentialDir, "config.toml"), "model = 'kimi-k2'\n");
    const agent = new KimiAgent({ credentialDir });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      const runtimeHome = command.env?.KIMI_SHARE_DIR;
      expect(typeof runtimeHome).toBe("string");
      expect(runtimeHome).not.toBe(credentialDir);
      // Credentials were seeded into the isolated runtime home.
      expect(existsSync(join(runtimeHome, "credentials", "token.json"))).toBe(true);
      expect(existsSync(join(runtimeHome, "config.toml"))).toBe(true);
      expect(agent.invocationHome).toBe(runtimeHome);
    } finally {
      await command.cleanup?.();
    }
  });

  test("legacy configDir behavior is unchanged (live child shares the dir)", async () => {
    const configDir = await tempDir("kimi-config-");
    const agent = new KimiAgent({ configDir });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      expect(command.env?.KIMI_SHARE_DIR).toBe(configDir);
    } finally {
      await command.cleanup?.();
    }
  });

  test("credentialDir and configDir are mutually exclusive", () => {
    expect(() => new KimiAgent({ credentialDir: "/a", configDir: "/b" })).toThrow(/credentialDir/);
  });
});

describe("KimiAgent invocation-local usage", () => {
  test("attaches the wire-log delta to the completed event", async () => {
    const credentialDir = await tempDir("kimi-creds-");
    const agent = new KimiAgent({ credentialDir, wireUsage: true });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      const runtimeHome = command.env?.KIMI_SHARE_DIR;
      const wireFile = join(runtimeHome, "wire.jsonl");
      // Baseline was taken at buildCommand; only records appended after it count.
      await writeFile(wireFile, `${USAGE_LINE({ output_tokens: 42 })}\n`);
      const interpreter = agent.createOutputInterpreter();
      const events = interpreter.onExit({ exitCode: 0, stdout: "", stderr: "" });
      const completed = events.find((event) => event.type === "completed");
      expect(completed?.usage).toEqual({
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        inputTokens: 100,
        outputTokens: 42,
      });
    } finally {
      await command.cleanup?.();
    }
  });

  test("does not re-bill usage recorded before a resume baseline", async () => {
    const credentialDir = await tempDir("kimi-creds-");
    const runtimeDir = await tempDir("kimi-runtime-");
    // Pre-seed the runtime home with historical wire records (resume state).
    await writeFile(join(runtimeDir, "wire.jsonl"), `${USAGE_LINE({ output_tokens: 999 })}\n`);
    const agent = new KimiAgent({ credentialDir, runtimeDir, wireUsage: true });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      await appendFile(join(runtimeDir, "wire.jsonl"), `${USAGE_LINE({ output_tokens: 3 })}\n`);
      const interpreter = agent.createOutputInterpreter();
      const completed = interpreter.onExit({ exitCode: 0, stdout: "", stderr: "" }).find((e) => e.type === "completed");
      expect(completed?.usage?.outputTokens).toBe(3);
    } finally {
      await command.cleanup?.();
    }
  });
});

describe("KimiAgent actual-session recovery", () => {
  test("publishes the actual session id resolved from CLI output", async () => {
    const credentialDir = await tempDir("kimi-creds-");
    /** @type {Array<{ sessionId: string; source: string }>} */
    const resolved = [];
    const agent = new KimiAgent({
      credentialDir,
      sessionRecovery: { onSessionResolved: (info) => resolved.push(info) },
    });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      const interpreter = agent.createOutputInterpreter();
      interpreter.onStdoutLine(JSON.stringify({ role: "assistant", content: "working" }));
      interpreter.onStderrLine("To resume this session: kimi -r actual-session-1");
      const completed = interpreter.onExit({ exitCode: 0, stdout: "", stderr: "" }).find((e) => e.type === "completed");
      expect(agent.issuedSessionId).toBe("actual-session-1");
      expect(completed?.resume).toBe("actual-session-1");
      expect(resolved).toEqual([
        {
          sessionId: "actual-session-1",
          source: "output",
          homeDir: agent.invocationHome,
          stateDir: join(agent.invocationHome, "sessions", "actual-session-1"),
        },
      ]);
    } finally {
      await command.cleanup?.();
    }
  });

  test("falls back to the on-disk session index on exit", async () => {
    const credentialDir = await tempDir("kimi-creds-");
    const runtimeDir = await tempDir("kimi-runtime-");
    await mkdir(join(runtimeDir, "sessions", "disk-session-9"), { recursive: true });
    const agent = new KimiAgent({ credentialDir, runtimeDir, sessionRecovery: true });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      const interpreter = agent.createOutputInterpreter();
      const completed = interpreter.onExit({ exitCode: 0, stdout: "", stderr: "" }).find((e) => e.type === "completed");
      expect(completed?.resume).toBe("disk-session-9");
    } finally {
      await command.cleanup?.();
    }
  });

  test("seeds resumed session state into the isolated home and persists it back", async () => {
    const credentialDir = await tempDir("kimi-creds-");
    const sessionStateDir = await tempDir("kimi-state-");
    await mkdir(join(sessionStateDir, "sessions", "sess-resume-1"), { recursive: true });
    await writeFile(join(sessionStateDir, "sessions", "sess-resume-1", "history.jsonl"), "prior\n");
    const agent = new KimiAgent({
      credentialDir,
      session: "sess-resume-1",
      sessionRecovery: true,
      sessionStateDir,
    });
    const command = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    try {
      const runtimeHome = command.env?.KIMI_SHARE_DIR;
      // Seed-in: the isolated home received the prior session state.
      expect(await readFile(join(runtimeHome, "sessions", "sess-resume-1", "history.jsonl"), "utf8")).toBe("prior\n");
      // Persist-out: new state written during the invocation is copied back.
      await appendFile(join(runtimeHome, "sessions", "sess-resume-1", "history.jsonl"), "new\n");
      const interpreter = agent.createOutputInterpreter();
      interpreter.onExit({ exitCode: 0, stdout: "", stderr: "" });
      expect(await readFile(join(sessionStateDir, "sessions", "sess-resume-1", "history.jsonl"), "utf8")).toBe(
        "prior\nnew\n",
      );
    } finally {
      await command.cleanup?.();
    }
  });
});
