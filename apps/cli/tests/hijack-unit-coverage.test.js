import { describe, expect, test } from "bun:test";
import {
  buildHijackLaunchSpec,
  isNativeHijackCandidate,
  launchHijackSession,
  resolveHijackCandidate,
  waitForHijackCandidate,
} from "../src/hijack.js";

/**
 * The `resolveHijackCandidate(adapter, ...)` seam takes a durable-store adapter;
 * these tests drive it with an in-memory adapter double that returns the same
 * shapes SmithersDb.listAttemptsForRun/getRun/getAttempt do.
 */
function attempt(overrides = {}) {
  return {
    nodeId: "node",
    iteration: 0,
    attempt: 1,
    startedAtMs: 1000,
    metaJson: null,
    jjCwd: null,
    ...overrides,
  };
}

function adapterWithAttempts(attempts, run = { status: "finished" }) {
  return {
    async listAttemptsForRun() {
      return attempts;
    },
    async getRun() {
      return run;
    },
    async listEventsByType() {
      return [];
    },
  };
}

describe("resolveHijackCandidate", () => {
  test("returns null when no attempt carries a hijack continuation", async () => {
    const adapter = adapterWithAttempts([
      attempt({ metaJson: null }),
      attempt({ metaJson: "not json" }),
      attempt({ metaJson: JSON.stringify(["array-not-object"]) }),
      attempt({ metaJson: JSON.stringify({ unrelated: true }) }),
    ]);
    expect(await resolveHijackCandidate(adapter, "run-1")).toBeNull();
  });

  test("extracts a native-cli continuation from hijackHandoff and defaults cwd", async () => {
    const adapter = adapterWithAttempts([
      attempt({
        nodeId: "task-a",
        metaJson: JSON.stringify({
          hijackHandoff: { engine: "codex", mode: "native-cli", resume: "sess-1" },
        }),
      }),
    ]);
    const candidate = await resolveHijackCandidate(adapter, "run-1");
    expect(candidate).toMatchObject({
      runId: "run-1",
      nodeId: "task-a",
      engine: "codex",
      mode: "native-cli",
      resume: "sess-1",
    });
    expect(candidate.messages).toBeUndefined();
    expect(candidate.cwd).toBe(process.cwd());
  });

  test("extracts a conversation continuation from hijackHandoff and keeps jjCwd", async () => {
    const adapter = adapterWithAttempts([
      attempt({
        jjCwd: "/work/dir",
        metaJson: JSON.stringify({
          hijackHandoff: {
            engine: "claude-code",
            mode: "conversation",
            messages: [{ role: "user", content: "hi" }],
          },
        }),
      }),
    ]);
    const candidate = await resolveHijackCandidate(adapter, "run-1");
    expect(candidate.mode).toBe("conversation");
    expect(candidate.messages).toHaveLength(1);
    expect(candidate.resume).toBeUndefined();
    expect(candidate.cwd).toBe("/work/dir");
  });

  test("falls back to agentEngine/agentResume meta fields", async () => {
    const adapter = adapterWithAttempts([
      attempt({
        metaJson: JSON.stringify({ agentEngine: "pi", agentResume: "resume-token" }),
      }),
    ]);
    const candidate = await resolveHijackCandidate(adapter, "run-1");
    expect(candidate).toMatchObject({ engine: "pi", mode: "native-cli", resume: "resume-token" });
  });

  test("falls back to agentConversation meta field", async () => {
    const adapter = adapterWithAttempts([
      attempt({
        metaJson: JSON.stringify({
          agentEngine: "kimi",
          agentConversation: [{ role: "assistant", content: "x" }],
        }),
      }),
    ]);
    const candidate = await resolveHijackCandidate(adapter, "run-1");
    expect(candidate).toMatchObject({ engine: "kimi", mode: "conversation" });
  });

  test("ignores an incomplete hijackHandoff and returns null with no meta fallback", async () => {
    const adapter = adapterWithAttempts([
      attempt({
        metaJson: JSON.stringify({ hijackHandoff: { engine: "codex", mode: "native-cli" } }),
      }),
    ]);
    expect(await resolveHijackCandidate(adapter, "run-1")).toBeNull();
  });

  test("target filter skips non-matching engine/node but matches by nodeId", async () => {
    const attempts = [
      attempt({
        nodeId: "task-a",
        metaJson: JSON.stringify({ agentEngine: "codex", agentResume: "s1" }),
      }),
    ];
    const adapter = adapterWithAttempts(attempts);
    expect(await resolveHijackCandidate(adapter, "run-1", "does-not-match")).toBeNull();
    expect((await resolveHijackCandidate(adapter, "run-1", "task-a")).engine).toBe("codex");
    expect((await resolveHijackCandidate(adapter, "run-1", "codex")).nodeId).toBe("task-a");
  });

  test("sorts newest attempt first across time, iteration, and attempt", async () => {
    const attempts = [
      attempt({
        nodeId: "older",
        startedAtMs: 500,
        metaJson: JSON.stringify({ agentEngine: "codex", agentResume: "old" }),
      }),
      attempt({
        nodeId: "same-time-hi-iter",
        startedAtMs: 1000,
        iteration: 2,
        metaJson: JSON.stringify({ agentEngine: "codex", agentResume: "iter" }),
      }),
      attempt({
        nodeId: "same-time-lo-iter",
        startedAtMs: 1000,
        iteration: 1,
        attempt: 5,
        metaJson: JSON.stringify({ agentEngine: "codex", agentResume: "attempt" }),
      }),
    ];
    const adapter = adapterWithAttempts(attempts);
    const candidate = await resolveHijackCandidate(adapter, "run-1");
    expect(candidate.nodeId).toBe("same-time-hi-iter");
  });
});

describe("waitForHijackCandidate", () => {
  test("returns the candidate once the run stops running", async () => {
    const adapter = {
      async getRun() {
        return { status: "waiting-approval" };
      },
      async listAttemptsForRun() {
        return [attempt({ metaJson: JSON.stringify({ agentEngine: "codex", agentResume: "s1" }) })];
      },
      async listEventsByType() {
        return [];
      },
    };
    const candidate = await waitForHijackCandidate(adapter, "run-1", { timeoutMs: 1000 });
    expect(candidate.engine).toBe("codex");
  });

  test("throws HIJACK_TIMEOUT when no candidate appears before the deadline", async () => {
    const adapter = {
      async getRun() {
        return { status: "running" };
      },
      async listAttemptsForRun() {
        return [];
      },
      async listEventsByType() {
        return [];
      },
    };
    await expect(waitForHijackCandidate(adapter, "run-1", { timeoutMs: 1 })).rejects.toThrow(/Timed out waiting/);
  });
});

describe("buildHijackLaunchSpec", () => {
  test("throws for a non-native-cli candidate", () => {
    expect(() => buildHijackLaunchSpec({ engine: "claude-code", mode: "conversation" })).toThrow(
      /conversation hijack flow/,
    );
  });

  test("claude-code clears entrypoint env vars", () => {
    const prevEntry = process.env.CLAUDE_CODE_ENTRYPOINT;
    const prevCode = process.env.CLAUDECODE;
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CLAUDECODE = "1";
    try {
      const spec = buildHijackLaunchSpec({ engine: "claude-code", mode: "native-cli", resume: "r", cwd: "/c" });
      expect(spec.command).toBe("claude");
      expect(spec.args).toEqual(["--resume", "r"]);
      expect(spec.env.CLAUDE_CODE_ENTRYPOINT).toBe("");
      expect(spec.env.CLAUDECODE).toBe("");
    } finally {
      if (prevEntry === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = prevEntry;
      if (prevCode === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prevCode;
    }
  });

  test("maps every native engine to its resume command", () => {
    const base = { mode: "native-cli", resume: "R", cwd: "/c" };
    expect(buildHijackLaunchSpec({ ...base, engine: "antigravity" }).command).toBe("agy");
    expect(buildHijackLaunchSpec({ ...base, engine: "pi" }).command).toBe("pi");
    expect(buildHijackLaunchSpec({ ...base, engine: "kimi" }).args).toEqual(["--session", "R", "--work-dir", "/c"]);
    expect(buildHijackLaunchSpec({ ...base, engine: "forge" }).args).toEqual(["--conversation-id", "R", "-C", "/c"]);
    expect(buildHijackLaunchSpec({ ...base, engine: "amp" }).args).toEqual(["threads", "continue", "R"]);
    expect(buildHijackLaunchSpec({ ...base, engine: "codex" }).command).toBe("codex");
  });
});

describe("isNativeHijackCandidate", () => {
  test("true only for native-cli with a resume and a known engine", () => {
    expect(isNativeHijackCandidate({ mode: "native-cli", resume: "r", engine: "codex" })).toBe(true);
    expect(isNativeHijackCandidate({ mode: "conversation", resume: "r", engine: "codex" })).toBe(false);
    expect(isNativeHijackCandidate({ mode: "native-cli", resume: "r", engine: "unknown-engine" })).toBe(false);
  });
});

describe("launchHijackSession", () => {
  test("resolves with the child exit code", async () => {
    const code = await launchHijackSession({ command: "true", args: [], cwd: process.cwd(), env: process.env });
    expect(code).toBe(0);
  });

  test("rejects when the command cannot be spawned", async () => {
    await expect(
      launchHijackSession({
        command: "/nonexistent/definitely-not-a-real-binary-xyz",
        args: [],
        cwd: process.cwd(),
        env: process.env,
      }),
    ).rejects.toBeDefined();
  });
});
