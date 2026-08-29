import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";

/**
 * Collect every `--settings` value in an argv, covering both the
 * `--settings X` (flag + value) and `--settings=X` (inline) forms.
 * @param {string[]} args
 * @returns {string[]}
 */
function settingsValues(args) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--settings" && typeof args[i + 1] === "string") {
      values.push(args[i + 1]);
    } else if (typeof a === "string" && a.startsWith("--settings=")) {
      values.push(a.slice("--settings=".length));
    }
  }
  return values;
}

/**
 * A merged `--settings` value is now always a private temp-file PATH (never
 * inline JSON on argv, so secrets folded in from a settings file never
 * round-trip through a world-readable process listing). Resolve a settings
 * value to its parsed object by reading the file it points to.
 * @param {string} value
 * @returns {Promise<Record<string, unknown>>}
 */
async function readMergedSettings(value) {
  return JSON.parse(await readFile(value, "utf8"));
}

describe("ClaudeCodeAgent first-class effort", () => {
  test("merges effortLevel into a single --settings flag", async () => {
    const agent = new ClaudeCodeAgent({ model: "claude-sonnet-5", effort: "xhigh" });
    const cmd = await agent.buildCommand({
      prompt: "hello",
      cwd: process.cwd(),
      options: {},
    });
    const values = settingsValues(cmd.args);
    expect(values.length).toBe(1);
    expect((await readMergedSettings(values[0])).effortLevel).toBe("xhigh");
  });

  test("MERGES effortLevel INTO a user --settings that lacks it, keeping ONE flag and preserving user keys", async () => {
    const agent = new ClaudeCodeAgent({
      effort: "high",
      // User already passed --settings inline JSON, but WITHOUT effortLevel.
      extraArgs: ["--settings", JSON.stringify({ custom: true, nested: { a: 1 } })],
    });
    const cmd = await agent.buildCommand({
      prompt: "hello",
      cwd: process.cwd(),
      options: {},
    });
    const values = settingsValues(cmd.args);
    // Exactly one --settings — ours merged into the user's token, never duplicated.
    expect(values.length).toBe(1);
    const parsed = await readMergedSettings(values[0]);
    // Our effort was merged in...
    expect(parsed.effortLevel).toBe("high");
    // ...and the user's own keys survive untouched.
    expect(parsed.custom).toBe(true);
    expect(parsed.nested).toEqual({ a: 1 });
  });

  test("user effortLevel WINS on conflict, still exactly one --settings", async () => {
    const agent = new ClaudeCodeAgent({
      effort: "high",
      extraArgs: ["--settings", JSON.stringify({ effortLevel: "medium", custom: true })],
    });
    const cmd = await agent.buildCommand({
      prompt: "hello",
      cwd: process.cwd(),
      options: {},
    });
    const values = settingsValues(cmd.args);
    expect(values.length).toBe(1);
    const parsed = await readMergedSettings(values[0]);
    expect(parsed.effortLevel).toBe("medium");
    expect(parsed.custom).toBe(true);
  });

  test("accepts the inline `--settings=<json>` form too, merged into exactly one flag", async () => {
    const agent = new ClaudeCodeAgent({
      effort: "max",
      extraArgs: [`--settings=${JSON.stringify({ custom: 42 })}`],
    });
    const cmd = await agent.buildCommand({
      prompt: "hello",
      cwd: process.cwd(),
      options: {},
    });
    const values = settingsValues(cmd.args);
    expect(values.length).toBe(1);
    const parsed = await readMergedSettings(values[0]);
    expect(parsed.effortLevel).toBe("max");
    expect(parsed.custom).toBe(42);
    // The user token is consumed and re-emitted as one canonical
    // `--settings <value>` flag — no leftover `--settings=` duplicate.
    expect(cmd.args.filter((a) => typeof a === "string" && a.startsWith("--settings=")).length).toBe(0);
  });

  test("a `settings` value that PARSES to a non-object (array/scalar) is passed through, not dropped", async () => {
    // A settings string can JSON.parse successfully yet not be an object — e.g.
    // a settings file literally named `[1,2,3]` / `42` / `true`. The old code
    // only handled parse-throw (file path) and inline objects, so a
    // non-object-parse value silently vanished (no --settings emitted). It must
    // now be treated as a file PATH and emitted verbatim as the sole --settings.
    const agent = new ClaudeCodeAgent({
      model: "claude-sonnet-5",
      settings: "[1,2,3]",
    });
    const cmd = await agent.buildCommand({
      prompt: "hello",
      cwd: process.cwd(),
      options: {},
    });
    expect(settingsValues(cmd.args)).toEqual(["[1,2,3]"]);
  });

  // --- settings-FILE-path cases: `--settings <file-or-json>` is single-valued
  // (last-wins), so effort must MERGE into a settings FILE, never ride as a
  // second flag that would clobber the file. ---

  test("MERGES effortLevel into a readable user --settings FILE path, exactly ONE flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-effort-file-"));
    const file = join(dir, "prod.json");
    await Bun.write(file, JSON.stringify({ permissions: { allow: ["Bash"] } }));
    try {
      const agent = new ClaudeCodeAgent({
        effort: "high",
        // User passes a --settings FILE PATH (not inline JSON) in extraArgs.
        extraArgs: ["--settings", file],
      });
      const cmd = await agent.buildCommand({ prompt: "hi", cwd: dir, options: {} });
      const values = settingsValues(cmd.args);
      // One flag — the file content merged with our effortLevel, not duplicated.
      expect(values.length).toBe(1);
      const parsed = await readMergedSettings(values[0]);
      expect(parsed.effortLevel).toBe("high");
      expect(parsed.permissions).toEqual({ allow: ["Bash"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a readable settings FILE's own effortLevel WINS over the effort option, one flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-effort-file-win-"));
    const file = join(dir, "prod.json");
    await Bun.write(file, JSON.stringify({ effortLevel: "low", custom: true }));
    try {
      const agent = new ClaudeCodeAgent({ effort: "high", extraArgs: ["--settings", file] });
      const cmd = await agent.buildCommand({ prompt: "hi", cwd: dir, options: {} });
      const values = settingsValues(cmd.args);
      expect(values.length).toBe(1);
      const parsed = await readMergedSettings(values[0]);
      // The user's file (higher precedence) wins the effortLevel conflict.
      expect(parsed.effortLevel).toBe("low");
      expect(parsed.custom).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("MERGES effortLevel into an opts.settings FILE path (readable), exactly ONE flag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-effort-opts-file-"));
    const file = join(dir, "prod.json");
    await Bun.write(file, JSON.stringify({ permissions: { allow: ["Read"] } }));
    try {
      // effort via opts, settings supplied as a file PATH (non-JSON string).
      const agent = new ClaudeCodeAgent({ effort: "xhigh", settings: file });
      const cmd = await agent.buildCommand({ prompt: "hi", cwd: dir, options: {} });
      const values = settingsValues(cmd.args);
      expect(values.length).toBe(1);
      const parsed = await readMergedSettings(values[0]);
      expect(parsed.effortLevel).toBe("xhigh");
      expect(parsed.permissions).toEqual({ allow: ["Read"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an UNREADABLE user --settings FILE is preserved verbatim as the sole flag (no clobber, no duplicate)", async () => {
    const agent = new ClaudeCodeAgent({
      effort: "high",
      extraArgs: ["--settings", "/no/such/prod.json"],
    });
    const cmd = await agent.buildCommand({ prompt: "hi", cwd: process.cwd(), options: {} });
    const values = settingsValues(cmd.args);
    // Exactly one --settings, and it is the user's file path — our effort JSON
    // is NOT emitted as a second flag that would clobber the file.
    expect(values.length).toBe(1);
    expect(values[0]).toBe("/no/such/prod.json");
  });
});
