import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveClaudeSessionCwd, resolveHijackCandidate } from "../src/hijack.js";

function makeAdapter(attempts) {
  return {
    listAttemptsForRun: async () => attempts,
  };
}

describe("resolveHijackCandidate cwd chain", () => {
  test("prefers meta.agentCwd over jjCwd and process.cwd()", async () => {
    const adapter = makeAdapter([
      {
        nodeId: "synthesize",
        iteration: 0,
        attempt: 1,
        startedAtMs: 100,
        jjCwd: "/wrong/worktree",
        metaJson: JSON.stringify({
          agentEngine: "claude-code",
          agentResume: "sess-abc",
          agentCwd: "/home/jm/dev/harnussy/kata",
        }),
      },
    ]);
    const candidate = await resolveHijackCandidate(adapter, "run-1");
    expect(candidate).not.toBeNull();
    expect(candidate?.cwd).toBe("/home/jm/dev/harnussy/kata");
    expect(candidate?.resume).toBe("sess-abc");
  });

  test("falls back to jjCwd when agentCwd missing and no session file", async () => {
    const adapter = makeAdapter([
      {
        nodeId: "worker",
        iteration: 0,
        attempt: 1,
        startedAtMs: 100,
        jjCwd: "/worktree/path",
        metaJson: JSON.stringify({
          agentEngine: "claude-code",
          agentResume: "sess-no-such-session-zzzz",
        }),
      },
    ]);
    const candidate = await resolveHijackCandidate(adapter, "run-2");
    expect(candidate?.cwd).toBe("/worktree/path");
  });

  test("resolveClaudeSessionCwd reads cwd from transcript", () => {
    const home = join(tmpdir(), `claude-home-${Date.now()}`);
    const project = join(home, ".claude", "projects", "-home-jm-dev-harnussy-kata");
    mkdirSync(project, { recursive: true });
    const sid = "11111111-2222-3333-4444-555555555555";
    writeFileSync(
      join(project, `${sid}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: "/home/jm/dev/harnussy/kata", sessionId: sid })}\n`,
    );
    try {
      expect(resolveClaudeSessionCwd(sid, { home })).toBe("/home/jm/dev/harnussy/kata");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
