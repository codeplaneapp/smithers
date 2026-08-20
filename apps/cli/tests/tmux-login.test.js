import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureLoginUrl,
  credentialsPresent,
  loginSessionName,
  runAgentAddWithTmuxLogin,
  tmuxAvailable,
  waitForLoginCredentials,
} from "../src/agent-commands/tmuxLogin.js";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe("loginSessionName", () => {
  test("prefixes and sanitizes tmux-hostile characters", () => {
    expect(loginSessionName("claude-1")).toBe("smithers-login-claude-1");
    expect(loginSessionName("work.acct:2")).toBe("smithers-login-work-acct-2");
  });
});

/** @param {number} expiresAt */
function claudeCredentials(expiresAt) {
  return JSON.stringify({
    claudeAiOauth: { accessToken: "sk-ant-oat-test", expiresAt, subscriptionType: "max" },
  });
}

describe("credentialsPresent", () => {
  test("claude-code requires .credentials.json, not just onboarding scratch", () => {
    const dir = tempDir("smithers-tmux-claude-");
    writeFileSync(join(dir, "settings.json"), "{}");
    expect(credentialsPresent("claude-code", dir)).toBe(false);
    writeFileSync(join(dir, ".credentials.json"), claudeCredentials(Date.now() + 3_600_000));
    expect(credentialsPresent("claude-code", dir)).toBe(true);
  });

  test("claude-code treats an expired token as not logged in", () => {
    // A lapsed token used to count as a finished login, so every login path
    // short-circuited and the seat could never be re-authenticated.
    const dir = tempDir("smithers-tmux-expired-");
    writeFileSync(join(dir, ".credentials.json"), claudeCredentials(Date.now() - 1_000));
    expect(credentialsPresent("claude-code", dir)).toBe(false);
  });

  test("claude-code accepts a token with no recorded expiry", () => {
    const dir = tempDir("smithers-tmux-noexpiry-");
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat" } }));
    expect(credentialsPresent("claude-code", dir)).toBe(true);
  });

  test("claude-code ignores a stale .claude.json login marker with no token", () => {
    // The marker outlives the token it describes. Accepting it as proof of
    // login made `agents add` skip the browser sign-in for an account holding
    // no credential at all, so the seat could never be recovered.
    const dir = tempDir("smithers-tmux-marker-");
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
    expect(credentialsPresent("claude-code", dir)).toBe(false);
  });

  test("codex requires auth.json", () => {
    const dir = tempDir("smithers-tmux-codex-");
    expect(credentialsPresent("codex", dir)).toBe(false);
    writeFileSync(join(dir, "auth.json"), "{}");
    expect(credentialsPresent("codex", dir)).toBe(true);
  });
});

describe("captureLoginUrl", () => {
  test("returns null when the session does not exist", () => {
    expect(captureLoginUrl("smithers-login-not-a-real-session")).toBe(null);
  });

  test.skipIf(!tmuxAvailable())("scrapes the OAuth URL out of a live pane", () => {
    const session = `smithers-test-url-${process.pid}`;
    const url = "https://claude.ai/oauth/authorize?code=1&state=abc";
    spawnSync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "220",
      "-y",
      "50",
      "sh",
      "-c",
      `echo '${url}'; sleep 30`,
    ]);
    try {
      let found = null;
      // The pane needs a moment to render the line the shell just wrote.
      for (let i = 0; i < 50 && !found; i++) {
        found = captureLoginUrl(session);
        if (!found) sleepSync(20);
      }
      expect(found).toBe(url);
    } finally {
      spawnSync("tmux", ["kill-session", "-t", session]);
    }
  });

  test.skipIf(!tmuxAvailable())("prefers an auth URL over an unrelated link", () => {
    const session = `smithers-test-url2-${process.pid}`;
    spawnSync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "220",
      "-y",
      "50",
      "sh",
      "-c",
      "echo 'docs at https://docs.example.com/help'; echo 'go to https://auth.openai.com/authorize?x=1'; sleep 30",
    ]);
    try {
      let found = null;
      for (let i = 0; i < 50 && !found; i++) {
        found = captureLoginUrl(session);
        if (found && !/authorize/.test(found)) found = null;
        if (!found) sleepSync(20);
      }
      expect(found).toBe("https://auth.openai.com/authorize?x=1");
    } finally {
      spawnSync("tmux", ["kill-session", "-t", session]);
    }
  });
});

describe("waitForLoginCredentials", () => {
  test("resolves once the credential artifact appears", async () => {
    const dir = tempDir("smithers-tmux-wait-");
    setTimeout(() => writeFileSync(join(dir, "auth.json"), "{}"), 60);
    const result = await waitForLoginCredentials({ provider: "codex", configDir: dir, timeoutMs: 5_000, pollMs: 20 });
    expect(result.ok).toBe(true);
  });

  test("a pre-existing claude login marker does not end the wait", async () => {
    // Otherwise the wait returns instantly for an account whose token is gone,
    // and registration records a seat that cannot authenticate.
    const dir = tempDir("smithers-tmux-stale-marker-");
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
    const result = await waitForLoginCredentials({
      provider: "claude-code",
      configDir: dir,
      timeoutMs: 80,
      pollMs: 20,
    });
    expect(result.ok).toBe(false);
  });

  test("a claude login marker that appears during the wait counts as success", async () => {
    const dir = tempDir("smithers-tmux-fresh-marker-");
    setTimeout(
      () => writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } })),
      60,
    );
    const result = await waitForLoginCredentials({
      provider: "claude-code",
      configDir: dir,
      timeoutMs: 5_000,
      pollMs: 20,
    });
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
