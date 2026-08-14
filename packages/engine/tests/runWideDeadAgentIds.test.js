import { describe, expect, test } from "bun:test";
import { runWideDeadAgentIds } from "../src/runWideDeadAgentIds.js";

const NOW = 1_700_000_000_000;

/**
 * @param {{ agentId?: string; code?: string; details?: Record<string, unknown>; state?: string }} spec
 */
function attempt(spec) {
  return {
    state: spec.state ?? "failed",
    metaJson: spec.agentId === undefined ? null : JSON.stringify({ kind: "agent", agentId: spec.agentId }),
    errorJson: spec.code === undefined ? null : JSON.stringify({ code: spec.code, details: spec.details ?? {} }),
  };
}

describe("runWideDeadAgentIds", () => {
  test("a quota-exhausted agent is dead for the rest of the run", () => {
    const dead = runWideDeadAgentIds([attempt({ agentId: "kimi", code: "AGENT_QUOTA_EXCEEDED" })], { nowMs: NOW });
    expect([...dead]).toEqual(["kimi"]);
  });

  test("quota marked only via error details still counts", () => {
    const dead = runWideDeadAgentIds(
      [attempt({ agentId: "kimi", code: "AGENT_FAILED", details: { failureQuota: true } })],
      {
        nowMs: NOW,
      },
    );
    expect(dead.has("kimi")).toBe(true);
  });

  test("a quota block whose reported reset has passed is usable again", () => {
    const rows = [
      attempt({ agentId: "kimi", code: "AGENT_QUOTA_EXCEEDED", details: { quotaResetAtMs: NOW - 1 } }),
      attempt({ agentId: "codex", code: "AGENT_QUOTA_EXCEEDED", details: { quotaResetAtMs: NOW + 60_000 } }),
    ];
    const dead = runWideDeadAgentIds(rows, { nowMs: NOW });
    expect(dead.has("kimi")).toBe(false);
    expect(dead.has("codex")).toBe(true);
  });

  test("one broken session is transient; two disable the engine", () => {
    const one = runWideDeadAgentIds([attempt({ agentId: "kimi", code: "AGENT_SESSION_LOST" })], { nowMs: NOW });
    expect(one.has("kimi")).toBe(false);
    const two = runWideDeadAgentIds(
      [
        attempt({ agentId: "kimi", code: "AGENT_SESSION_LOST" }),
        attempt({ agentId: "kimi", code: "AGENT_SESSION_LOST" }),
      ],
      { nowMs: NOW },
    );
    expect(two.has("kimi")).toBe(true);
  });

  test("healthy agents and non-terminal classifications are never disabled", () => {
    const rows = [
      attempt({ agentId: "claude", state: "finished" }),
      attempt({ agentId: "claude", code: "INVALID_OUTPUT" }),
      attempt({ agentId: "codex", code: "AGENT_CONFIG_INVALID" }),
      attempt({ code: "AGENT_QUOTA_EXCEEDED" }),
    ];
    expect([...runWideDeadAgentIds(rows, { nowMs: NOW })]).toEqual([]);
  });

  test("malformed attempt json degrades to no disable", () => {
    const rows = [{ state: "failed", metaJson: "{oops", errorJson: "]" }];
    expect([...runWideDeadAgentIds(rows, { nowMs: NOW })]).toEqual([]);
  });
});
