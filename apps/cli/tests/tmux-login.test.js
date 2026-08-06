import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPresent,
  loginSessionName,
  runAgentAddWithTmuxLogin,
  waitForLoginCredentials,
} from "../src/agent-commands/tmuxLogin.js";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("loginSessionName", () => {
  test("prefixes and sanitizes tmux-hostile characters", () => {
    expect(loginSessionName("claude-1")).toBe("smithers-login-claude-1");
    expect(loginSessionName("work.acct:2")).toBe("smithers-login-work-acct-2");
  });
});

describe("credentialsPresent", () => {
  test("claude-code requires .credentials.json, not just onboarding scratch", () => {
    const dir = tempDir("smithers-tmux-claude-");
    writeFileSync(join(dir, "settings.json"), "{}");
    expect(credentialsPresent("claude-code", dir)).toBe(false);
    writeFileSync(join(dir, ".credentials.json"), "{}");
    expect(credentialsPresent("claude-code", dir)).toBe(true);
  });

  test("codex requires auth.json", () => {
    const dir = tempDir("smithers-tmux-codex-");
    expect(credentialsPresent("codex", dir)).toBe(false);
    writeFileSync(join(dir, "auth.json"), "{}");
    expect(credentialsPresent("codex", dir)).toBe(true);
  });
});

describe("waitForLoginCredentials", () => {
  test("resolves once the credential artifact appears", async () => {
    const dir = tempDir("smithers-tmux-wait-");
    setTimeout(() => writeFileSync(join(dir, "auth.json"), "{}"), 60);
    const result = await waitForLoginCredentials({ provider: "codex", configDir: dir, timeoutMs: 5_000, pollMs: 20 });
    expect(result.ok).toBe(true);
  });

  test("times out when nothing appears", async () => {
    const dir = tempDir("smithers-tmux-timeout-");
    const result = await waitForLoginCredentials({ provider: "codex", configDir: dir, timeoutMs: 80, pollMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(80);
  });
});

describe("runAgentAddWithTmuxLogin", () => {
  test("rejects api-key providers", async () => {
    const result = await runAgentAddWithTmuxLogin({ provider: "anthropic-api", label: "api-1" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-a-subscription-provider");
  });

  test("reports tmux-missing when tmux is not on PATH", async () => {
    const home = tempDir("smithers-tmux-nohome-");
    const result = await runAgentAddWithTmuxLogin({
      provider: "codex",
      label: "codex-x",
      env: { SMITHERS_HOME: home, PATH: tempDir("smithers-empty-path-") },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux-missing");
  });

  test("registers immediately when credentials already exist, without touching tmux", async () => {
    const home = tempDir("smithers-tmux-home-");
    const configDir = join(home, "accounts", "codex-ready");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "auth.json"), "{}");
    const statuses = [];
    const result = await runAgentAddWithTmuxLogin({
      provider: "codex",
      label: "codex-ready",
      env: { SMITHERS_HOME: home, PATH: process.env.PATH },
      cwd: home,
      onStatus: (message) => statuses.push(message),
    });
    expect(result.ok).toBe(true);
    expect(result.account.label).toBe("codex-ready");
    expect(result.account.configDir).toBe(configDir);
    const registry = JSON.parse(readFileSync(join(home, "accounts.json"), "utf8"));
    expect(registry.accounts.map((a) => a.label)).toEqual(["codex-ready"]);
    expect(statuses.join("\n")).toContain("already present");
  });
});
