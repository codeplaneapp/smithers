import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDirPath } from "../../../packages/testing/src/cleanup/tempDir.ts";
import { reauthClaudeAccounts } from "../src/agent-commands/reauthClaudeAccounts.js";
import { readAccountQuotaState, recordAccountQuotaLimit } from "@smthrs/usage";

function account(root, label, email, organizationUuid) {
  const configDir = join(root, label);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `${label}-account`, organizationUuid } }),
  );
  return { label, provider: "claude-code", configDir };
}

describe("reauthClaudeAccounts", () => {
  test("skips healthy accounts and reports duplicate subscriptions", async () => {
    const root = makeTempDirPath("smithers-reauth-");
    const accounts = [
      account(root, "one", "same@example.com", "org-shared"),
      account(root, "two", "same@example.com", "org-shared"),
    ];
    const calls = [];
    const results = await reauthClaudeAccounts({
      accounts,
      env: { SMITHERS_HOME: root },
      spawn(command, args) {
        calls.push([command, ...args]);
        return { status: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
      },
      readCredentials: () => ({ accessToken: "live", expiresAt: Date.now() + 60_000 }),
      usageProbe: async () => ({ source: "oauth", windows: [], planType: "max" }),
    });
    expect(calls).toEqual([]);
    expect(results).toMatchObject([
      { label: "one", ok: true, reauthenticated: false, duplicateOf: ["two"] },
      { label: "two", ok: true, reauthenticated: false, duplicateOf: ["one"] },
    ]);
  });

  test("refreshes an expired token before deciding browser login is needed", async () => {
    const root = makeTempDirPath("smithers-reauth-refresh-");
    const accounts = [account(root, "one", "one@example.com", "org-one")];
    let refreshed = false;
    const calls = [];
    const results = await reauthClaudeAccounts({
      accounts,
      env: { SMITHERS_HOME: root },
      spawn(command, args) {
        calls.push([command, ...args]);
        if (args[0] === "auth" && args[1] === "status") {
          return { status: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
        }
        if (args[0] === "--print") refreshed = true;
        return { status: 0, stdout: JSON.stringify({ is_error: false, result: "OK" }), stderr: "" };
      },
      readCredentials: () => ({
        accessToken: refreshed ? "new" : "old",
        expiresAt: refreshed ? Date.now() + 60_000 : 1,
      }),
      usageProbe: async () => ({ source: refreshed ? "oauth" : "none", windows: [] }),
    });
    expect(calls.some((call) => call.includes("--print"))).toBe(true);
    expect(calls.some((call) => call.includes("login"))).toBe(false);
    expect(results[0]).toMatchObject({ ok: true, refreshed: true, reauthenticated: false });
  });

  test("force logs in each account sequentially and verifies a credential artifact", async () => {
    const root = makeTempDirPath("smithers-reauth-force-");
    const accounts = [
      account(root, "one", "one@example.com", "org-one"),
      account(root, "two", "two@example.com", "org-two"),
    ];
    const loggedIn = new Set();
    const calls = [];
    const results = await reauthClaudeAccounts({
      force: true,
      accounts,
      env: { SMITHERS_HOME: root },
      spawn(command, args, options) {
        const label = accounts.find((row) => row.configDir === options?.env?.CLAUDE_CONFIG_DIR)?.label ?? "default";
        calls.push(`${label}:${command}:${args.join(" ")}`);
        if (args[0] === "auth" && args[1] === "login") {
          loggedIn.add(label);
        }
        return {
          status: 0,
          stdout: args[0] === "auth" && args[1] === "status" ? JSON.stringify({ loggedIn: true }) : "",
          stderr: "",
        };
      },
      readCredentials: (target) =>
        loggedIn.has(accounts.find((row) => row.configDir === target.configDir)?.label)
          ? { accessToken: "new", expiresAt: Date.now() + 60_000 }
          : null,
      // A rate-limited usage endpoint must not invalidate the browser login
      // after Claude wrote credentials and `auth status` confirms them.
      usageProbe: async () => ({ source: "none", error: "Claude usage endpoint rate limited (429)" }),
    });
    const logins = calls.filter((call) => call.includes("claude:auth login"));
    expect(logins).toEqual(["one:claude:auth login --claudeai", "two:claude:auth login --claudeai"]);
    expect(results.map((row) => row.ok)).toEqual([true, true]);
  });

  test("removes stale credential files and quota markers after switching subscriptions", async () => {
    const root = makeTempDirPath("smithers-reauth-switch-");
    const target = account(root, "one", "old@example.com", "org-old");
    const credentialPath = join(target.configDir, ".credentials.json");
    writeFileSync(credentialPath, JSON.stringify({ claudeAiOauth: { accessToken: "old" } }));
    recordAccountQuotaLimit(target.label, { env: { SMITHERS_HOME: root }, untilMs: Date.now() + 60_000 });
    let loggedIn = false;
    const results = await reauthClaudeAccounts({
      force: true,
      accounts: [target],
      env: { SMITHERS_HOME: root },
      spawn(_command, args) {
        if (args[0] === "auth" && args[1] === "login") {
          loggedIn = true;
          writeFileSync(
            join(target.configDir, ".claude.json"),
            JSON.stringify({
              oauthAccount: {
                emailAddress: "new@example.com",
                accountUuid: "new-account",
                organizationUuid: "org-new",
              },
            }),
          );
        }
        return {
          status: 0,
          stdout: args[0] === "auth" && args[1] === "status" ? JSON.stringify({ loggedIn: true }) : "",
          stderr: "",
        };
      },
      readCredentials: () => (loggedIn ? { accessToken: "new", expiresAt: Date.now() + 60_000 } : null),
      usageProbe: async () => ({ source: "oauth", windows: [] }),
    });
    expect(results[0]).toMatchObject({ ok: true, signedInAs: "new@example.com" });
    expect(existsSync(credentialPath)).toBe(false);
    expect(readAccountQuotaState({ SMITHERS_HOME: root }).entries).toEqual({});
  });
});
