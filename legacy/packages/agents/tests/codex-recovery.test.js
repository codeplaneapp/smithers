import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAgent } from "../src/CodexAgent.js";
import { createHttp429RecoveryClassifier } from "../src/BaseCliAgent/index.js";
import { makeFakeNodeCli, prependPath } from "./fake-cli.js";

const originalPath = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.CODEX_ARGS_LOG;
  delete process.env.CODEX_COUNTER_FILE;
});

/**
 * Fake codex CLI driven by a counter file: each invocation bumps the
 * counter and runs the scripted behavior for that attempt index.
 *
 * @param {string} dir
 * @param {Record<number, { stdoutLines?: unknown[]; stderr?: string; exitCode?: number }>} script
 */
async function makeScriptedCodex(dir, script) {
  const counterFile = join(dir, "counter.txt");
  const argsLog = join(dir, "args.log");
  const scriptJson = JSON.stringify(script);
  const fake = await makeFakeNodeCli(
    dir,
    "codex",
    `
const fs = require("node:fs");
const counterFile = ${JSON.stringify(counterFile)};
const argsLog = ${JSON.stringify(argsLog)};
const script = JSON.parse(${JSON.stringify(scriptJson)});
let attempt = 0;
try { attempt = Number(fs.readFileSync(counterFile, "utf8")); } catch {}
fs.writeFileSync(counterFile, String(attempt + 1), "utf8");
const args = process.argv.slice(2);
fs.appendFileSync(argsLog, JSON.stringify(args) + "\\n", "utf8");
const step = script[String(attempt)] ?? script.default;
const outputIndex = args.indexOf("--output-last-message");
for (const line of step.stdoutLines ?? []) {
  process.stdout.write(JSON.stringify(line) + "\\n");
}
if (outputIndex >= 0 && args[outputIndex + 1] && step.lastMessage !== undefined) {
  fs.writeFileSync(args[outputIndex + 1], step.lastMessage, "utf8");
}
if (step.stderr) process.stderr.write(step.stderr + "\\n");
process.exit(step.exitCode ?? 0);
`,
  );
  return { ...fake, argsLog };
}

/** @param {string} argsLog */
async function readArgvLog(argsLog) {
  const raw = await readFile(argsLog, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * @param {{ maxAttempts?: number; backoffMs?: (attempt: number) => number }} [over]
 */
function make429Policy(over = {}) {
  return {
    maxAttempts: over.maxAttempts ?? 3,
    backoffMs: over.backoffMs ?? (() => 1),
    classifyError: createHttp429RecoveryClassifier(),
  };
}

describe("createHttp429RecoveryClassifier", () => {
  const classify = createHttp429RecoveryClassifier();
  const base = { attempt: 0, error: new Error("x"), stderrTail: "", stdoutTail: "", elapsedMs: 0 };
  test("classifies 429 before activity as a fresh retry", () => {
    expect(classify({ ...base, stderrTail: "429 Too Many Requests", hadSubstantiveActivity: false })).toEqual({
      kind: "retry-fresh",
      reason: "provider-429-before-activity",
    });
  });
  test("classifies 429 after activity as exact-session resume", () => {
    expect(
      classify({ ...base, stderrTail: "HTTP 429", hadSubstantiveActivity: true, resumeSession: "thread-1" }),
    ).toEqual({ kind: "resume-session", reason: "provider-429-after-activity" });
  });
  test("is terminal without a resumable session or for non-429 errors", () => {
    expect(classify({ ...base, stderrTail: "HTTP 429", hadSubstantiveActivity: true })).toEqual({
      kind: "terminal",
      reason: "provider-429-no-session",
    });
    expect(classify({ ...base, stderrTail: "syntax error", hadSubstantiveActivity: false })).toEqual({
      kind: "terminal",
    });
  });
});

describe("CodexAgent recoveryPolicy (provider 429 recovery)", () => {
  test("429 before substantive activity retries a fresh attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-codex-recovery-"));
    const fake = await makeScriptedCodex(dir, {
      0: {
        stdoutLines: [{ type: "thread.started", thread_id: "thread-pre" }],
        stderr: "429 Too Many Requests",
        exitCode: 1,
      },
      1: {
        stdoutLines: [
          { type: "thread.started", thread_id: "thread-fresh" },
          { type: "item.completed", item: { id: "m-1", type: "agent_message", text: "fresh ok" } },
          { type: "turn.completed" },
        ],
        lastMessage: "fresh ok",
      },
    });
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      /** @type {Array<{ type: string }>} */
      const events = [];
      const agent = new CodexAgent({ recoveryPolicy: make429Policy() });
      const result = await agent.generate({ prompt: "hi", onEvent: (event) => events.push(event) });
      expect(result.text).toBe("fresh ok");
      const argvLog = await readArgvLog(fake.argsLog);
      expect(argvLog.length).toBe(2);
      expect(argvLog[0][0]).toBe("exec");
      expect(argvLog[1][0]).toBe("exec");
      // Fresh retry: the second attempt is NOT a resume.
      expect(argvLog[1]).not.toContain("resume");
      // Only the terminal attempt's callbacks were released, each once.
      expect(events.filter((event) => event.type === "started").length).toBe(1);
      expect(events.filter((event) => event.type === "completed").length).toBe(1);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("429 after substantive activity resumes the exact emitted session without duplicated callbacks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-codex-recovery-"));
    const fake = await makeScriptedCodex(dir, {
      0: {
        stdoutLines: [
          { type: "thread.started", thread_id: "thread-post" },
          {
            type: "item.started",
            item: { id: "cmd-1", type: "command_execution", command: "make build", status: "in_progress" },
          },
        ],
        stderr: "429 Too Many Requests",
        exitCode: 1,
      },
      1: {
        // The resumed CLI replays the session's earlier items.
        stdoutLines: [
          { type: "thread.started", thread_id: "thread-post" },
          {
            type: "item.started",
            item: { id: "cmd-1", type: "command_execution", command: "make build", status: "in_progress" },
          },
          { type: "item.completed", item: { id: "m-9", type: "agent_message", text: "resumed ok" } },
          { type: "turn.completed" },
        ],
        lastMessage: "resumed ok",
      },
    });
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      /** @type {any[]} */
      const events = [];
      const agent = new CodexAgent({ recoveryPolicy: make429Policy() });
      const result = await agent.generate({ prompt: "hi", onEvent: (event) => events.push(event) });
      expect(result.text).toBe("resumed ok");
      const argvLog = await readArgvLog(fake.argsLog);
      expect(argvLog.length).toBe(2);
      // Exact-session resume: `exec resume ... thread-post`.
      expect(argvLog[1][0]).toBe("exec");
      expect(argvLog[1][1]).toBe("resume");
      expect(argvLog[1]).toContain("thread-post");
      // No duplicated lifecycle callbacks from the replay.
      expect(events.filter((event) => event.type === "started").length).toBe(1);
      const commandStarts = events.filter(
        (event) => event.type === "action" && event.action?.id === "cmd-1" && event.phase === "started",
      );
      expect(commandStarts.length).toBe(1);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("retry budget exhausted surfaces the original provider error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-codex-recovery-"));
    const fake = await makeScriptedCodex(dir, {
      default: {
        stdoutLines: [{ type: "thread.started", thread_id: "thread-x" }],
        stderr: "429 Too Many Requests",
        exitCode: 1,
      },
    });
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      /** @type {any[]} */
      const events = [];
      const agent = new CodexAgent({ recoveryPolicy: make429Policy({ maxAttempts: 2 }) });
      const failure = await agent
        .generate({ prompt: "hi", onEvent: (event) => events.push(event) })
        .then(() => undefined)
        .catch((error) => error);
      expect(failure).toBeDefined();
      expect(String(failure?.message ?? failure)).toContain("429");
      const argvLog = await readArgvLog(fake.argsLog);
      expect(argvLog.length).toBe(2);
      // The terminal attempt's quarantined callbacks were released.
      expect(events.filter((event) => event.type === "started").length).toBe(1);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("caller abort mid-retry cancels promptly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-codex-recovery-"));
    const fake = await makeScriptedCodex(dir, {
      default: {
        stdoutLines: [{ type: "thread.started", thread_id: "thread-a" }],
        stderr: "429 Too Many Requests",
        exitCode: 1,
      },
    });
    try {
      process.env.PATH = prependPath(fake.dir, originalPath);
      const controller = new AbortController();
      const agent = new CodexAgent({
        recoveryPolicy: make429Policy({ backoffMs: () => 60000 }),
      });
      const startedAt = Date.now();
      const pending = agent
        .generate({ prompt: "hi", abortSignal: controller.signal })
        .then(() => undefined)
        .catch((error) => error);
      setTimeout(() => controller.abort(), 100);
      const failure = await pending;
      const elapsedMs = Date.now() - startedAt;
      expect(failure).toBeDefined();
      expect(failure?.code ?? failure?.name).toMatch(/PROCESS_ABORTED|AbortError/);
      // Did not wait out the 60s backoff.
      expect(elapsedMs).toBeLessThan(10000);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 15000);
});
