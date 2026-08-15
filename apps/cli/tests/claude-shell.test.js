import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAccountQuotaLimit, writeUsageCache } from "@smthrs/usage";
import { parseClaudeShellArgs, runClaudeShell } from "../src/agent-commands/claudeShell.js";

const account = (label) => ({ label, provider: "claude-code", configDir: `/${label}` });
const sink = () => ({
  output: "",
  write(value) {
    this.output += value;
    return true;
  },
});

describe("claude-shell", () => {
  test("parses wrapper flags and forwards Claude flags", () => {
    expect(parseClaudeShellArgs(["--label", "claude-2", "--", "--model", "opus"])).toEqual({
      label: "claude-2",
      dryRun: false,
      forwarded: ["--model", "opus"],
    });
  });

  test("forwards Claude help after the separator", () => {
    const spawn = mock(() => ({ status: 0 }));
    expect(
      runClaudeShell(["--", "--help"], {
        accounts: [account("claude-1")],
        spawn,
        stderr: sink(),
      }),
    ).toBe(0);
    expect(spawn).toHaveBeenCalledWith("claude", ["--help"], expect.any(Object));
  });

  test("skips persisted quota blocks and execs the best account", () => {
    const env = { SMITHERS_HOME: mkdtempSync(join(tmpdir(), "smithers-shell-")) };
    recordAccountQuotaLimit("claude-1", { env, untilMs: Date.now() + 60_000 });
    const spawn = mock(() => ({ status: 0 }));
    const stderr = sink();
    expect(
      runClaudeShell(["--model", "claude-fable-5"], {
        env,
        accounts: [account("claude-1"), account("claude-2")],
        spawn,
        stderr,
      }),
    ).toBe(0);
    expect(spawn).toHaveBeenCalledWith("claude", ["--model", "claude-fable-5"], {
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/claude-2", ANTHROPIC_API_KEY: "" }),
      stdio: "inherit",
    });
  });

  test("uses cached model-specific headroom", () => {
    const env = { SMITHERS_HOME: mkdtempSync(join(tmpdir(), "smithers-shell-")) };
    const report = (label, fable) => ({
      identity: { provider: "claude-code", configDir: `/${label}` },
      report: {
        accountLabel: label,
        provider: "claude-code",
        authMode: "subscription",
        source: "oauth",
        stale: false,
        estimate: false,
        fetchedAt: new Date().toISOString(),
        windows: [{ id: "weekly-fable", label: "weekly Fable", unit: "percent", usedPercent: fable }],
      },
    });
    writeUsageCache(
      { version: 1, entries: { "claude-1": report("claude-1", 90), "claude-2": report("claude-2", 10) } },
      env,
    );
    const stderr = sink();
    expect(
      runClaudeShell(["--dry-run", "--model=claude-fable-5"], {
        env,
        accounts: [account("claude-1"), account("claude-2")],
        stderr,
      }),
    ).toBe(0);
    expect(stderr.output).toContain("Using claude-2");
  });
});
