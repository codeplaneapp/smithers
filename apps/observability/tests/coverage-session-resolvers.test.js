import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolvePiSessionFile,
  resolveCodexSessionFile,
  resolveClaudeSessionFile,
} from "../src/_sessionFileResolvers.js";

/** @type {string[]} */
const tempDirs = [];
async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "smithers-session-cov-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolvePiSessionFile", () => {
  test("returns the explicit opts.session path immediately", async () => {
    const agent = { opts: { session: "/tmp/explicit-pi-session.jsonl" } };
    expect(await resolvePiSessionFile(agent, "sess-1")).toBe("/tmp/explicit-pi-session.jsonl");
  });
  test("returns null when there is no explicit session and no sessionId", async () => {
    expect(await resolvePiSessionFile({ opts: {} }, undefined)).toBeNull();
  });
  test("finds a jsonl file that contains the sessionId under opts.sessionDir", async () => {
    const base = await makeTempDir();
    const nested = join(base, "nested");
    await mkdir(nested, { recursive: true });
    const file = join(nested, "trace-sess-abc.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "start" })}\n`);
    const agent = { opts: { sessionDir: base } };
    expect(await resolvePiSessionFile(agent, "sess-abc")).toBe(file);
  });
  test("returns null when no file under opts.sessionDir matches the sessionId", async () => {
    const base = await makeTempDir();
    await writeFile(join(base, "other.jsonl"), "{}\n");
    const agent = { opts: { sessionDir: base } };
    expect(await resolvePiSessionFile(agent, "missing-session")).toBeNull();
  });
  test("uses the default ~/.pi root only for a PiAgent-named agent", async () => {
    class PiAgent {}
    const piAgent = Object.assign(new PiAgent(), { opts: {} });
    // No file exists for this random sessionId under the default root → null.
    expect(await resolvePiSessionFile(piAgent, "no-such-pi-session-xyz")).toBeNull();
    // A non-PiAgent with no custom dir has no roots to search → null.
    expect(await resolvePiSessionFile({ opts: {} }, "no-such-pi-session-xyz")).toBeNull();
  });
});

describe("resolveCodexSessionFile default roots", () => {
  test("a CodexAgent-named agent falls back to the default codex sessions root", async () => {
    class CodexAgent {}
    const agent = Object.assign(new CodexAgent(), { opts: {} });
    // Pin CODEX_HOME to an empty temp root: the operator's real ~/.codex
    // can hold thousands of sessions, which makes this scan minutes-slow
    // and non-hermetic.
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = await makeTempDir();
    try {
      expect(await resolveCodexSessionFile(agent, "/no/such/cwd/xyz", Date.now())).toBeNull();
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
  test("a non-CodexAgent with no custom dir has no roots and returns null", async () => {
    expect(await resolveCodexSessionFile({ opts: {} }, "/no/such/cwd/xyz", Date.now())).toBeNull();
  });
});

describe("resolveClaudeSessionFile default roots", () => {
  test("a ClaudeCodeAgent-named agent falls back to the default ~/.claude root", async () => {
    class ClaudeCodeAgent {}
    const agent = Object.assign(new ClaudeCodeAgent(), { opts: {} });
    expect(await resolveClaudeSessionFile(agent, "/no/such/cwd/xyz", "no-such-session-id")).toBeNull();
  });
  test("a non-ClaudeCodeAgent with no custom dir has no roots and returns null", async () => {
    expect(await resolveClaudeSessionFile({ opts: {} }, "/no/such/cwd/xyz", "no-such-session-id")).toBeNull();
  });
});
