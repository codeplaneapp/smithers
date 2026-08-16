import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDirPath } from "../../../packages/testing/src/cleanup/tempDir.ts";
import {
  findDuplicateAccounts,
  formatAccountIdentity,
  readAccountIdentity,
} from "../src/agent-commands/accountIdentity.js";

function tempDir(prefix) {
  return makeTempDirPath(prefix);
}

/** Build a config dir holding a Claude Code post-login state file. */
function claudeDir(email, accountUuid, organizationUuid) {
  const dir = tempDir("smithers-identity-claude-");
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid, organizationUuid } }),
  );
  return dir;
}

/** Build a config dir holding a Codex auth.json with an unsigned id_token. */
function codexDir(email, accountId) {
  const dir = tempDir("smithers-identity-codex-");
  const claims = Buffer.from(JSON.stringify({ email }), "utf8").toString("base64url");
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ tokens: { account_id: accountId, id_token: `header.${claims}.signature` } }),
  );
  return dir;
}

/** @type {(provider: string, configDir: string) => import("@smthrs/accounts").Account} */
const account = (label, provider, configDir) => ({ label, provider, configDir });

describe("readAccountIdentity", () => {
  test("reads the Claude subscription from .claude.json", () => {
    const dir = claudeDir("a@example.com", "uuid-a");
    expect(readAccountIdentity("claude-code", dir)).toEqual({ email: "a@example.com", accountId: "uuid-a" });
  });

  test("reads the Codex subscription from auth.json, decoding the id_token", () => {
    const dir = codexDir("b@example.com", "acct-b");
    expect(readAccountIdentity("codex", dir)).toEqual({ email: "b@example.com", accountId: "acct-b" });
  });

  test("returns null for a not-yet-logged-in dir, unknown provider, or missing configDir", () => {
    expect(readAccountIdentity("claude-code", tempDir("smithers-identity-empty-"))).toBeNull();
    expect(readAccountIdentity("kimi", claudeDir("c@example.com", "uuid-c"))).toBeNull();
    expect(readAccountIdentity("claude-code", undefined)).toBeNull();
  });

  test("never returns token material", () => {
    const dir = codexDir("d@example.com", "acct-d");
    const identity = readAccountIdentity("codex", dir);
    expect(Object.keys(identity).sort()).toEqual(["accountId", "email"]);
  });
});

describe("formatAccountIdentity", () => {
  test("prefers the email and falls back to a short account id", () => {
    expect(formatAccountIdentity({ email: "a@example.com", accountId: "uuid" })).toBe("a@example.com");
    expect(formatAccountIdentity({ accountId: "0123456789abcdef" })).toBe("account 01234567");
    expect(formatAccountIdentity(null)).toBe("");
  });
});

describe("findDuplicateAccounts", () => {
  test("flags another label logged into the same subscription", () => {
    const first = claudeDir("same@example.com", "uuid-same");
    const second = claudeDir("same@example.com", "uuid-same");
    const accounts = [account("claude-1", "claude-code", first), account("claude-2", "claude-code", second)];
    const identity = readAccountIdentity("claude-code", second);
    expect(findDuplicateAccounts(identity, "claude-code", accounts, "claude-2")).toEqual(["claude-1"]);
  });

  test("matches on account id even when the email differs", () => {
    const first = claudeDir("old@example.com", "uuid-shared");
    const second = claudeDir("new@example.com", "uuid-shared");
    const accounts = [account("claude-1", "claude-code", first)];
    const identity = readAccountIdentity("claude-code", second);
    expect(findDuplicateAccounts(identity, "claude-code", accounts, "claude-2")).toEqual(["claude-1"]);
  });

  test("distinct subscriptions are not duplicates", () => {
    const first = claudeDir("a@example.com", "uuid-a");
    const second = claudeDir("b@example.com", "uuid-b");
    const accounts = [account("claude-1", "claude-code", first)];
    const identity = readAccountIdentity("claude-code", second);
    expect(findDuplicateAccounts(identity, "claude-code", accounts, "claude-2")).toEqual([]);
  });

  test("organization id distinguishes subscriptions that share an email", () => {
    const first = claudeDir("same@example.com", "uuid-a", "org-a");
    const second = claudeDir("same@example.com", "uuid-b", "org-b");
    const accounts = [account("claude-1", "claude-code", first)];
    const identity = readAccountIdentity("claude-code", second);
    expect(findDuplicateAccounts(identity, "claude-code", accounts, "claude-2")).toEqual([]);
  });

  test("a Claude and a Codex seat sharing one email are NOT duplicates", () => {
    // Separate vendors, separate rate limits — flagging these would tell the
    // user to delete a seat that adds real capacity.
    const claude = claudeDir("will@example.com", "uuid-claude");
    const codex = codexDir("will@example.com", "acct-codex");
    const accounts = [account("codex-1", "codex", codex)];
    const identity = readAccountIdentity("claude-code", claude);
    expect(findDuplicateAccounts(identity, "claude-code", accounts, "claude-6")).toEqual([]);
  });

  test("an unreadable identity never reports duplicates", () => {
    const accounts = [account("claude-1", "claude-code", claudeDir("a@example.com", "uuid-a"))];
    expect(findDuplicateAccounts(null, "claude-code", accounts, "claude-2")).toEqual([]);
    expect(findDuplicateAccounts({}, "claude-code", accounts, "claude-2")).toEqual([]);
  });
});
