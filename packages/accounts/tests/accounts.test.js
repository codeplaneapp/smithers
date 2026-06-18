import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    accountsFilePath,
    accountsRoot,
    accountToProviderEnv,
    addAccount,
    defaultConfigDir,
    getAccount,
    listAccounts,
    parseAccountsFile,
    readAccounts,
    removeAccount,
    writeAccounts,
} from "../src/index.js";

/** @type {string[]} */
const tempDirs = [];

afterEach(() => {
    while (tempDirs.length) {
        const dir = tempDirs.pop();
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
});

function newSmithersHome() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-accounts-"));
    tempDirs.push(dir);
    return { SMITHERS_HOME: dir };
}

describe("accountsRoot / accountsFilePath / defaultConfigDir", () => {
    test("uses SMITHERS_HOME when set", () => {
        const env = { SMITHERS_HOME: "/tmp/x" };
        expect(accountsRoot(env)).toBe("/tmp/x");
        expect(accountsFilePath(env)).toBe("/tmp/x/accounts.json");
        expect(defaultConfigDir("foo", env)).toBe("/tmp/x/accounts/foo");
    });
    test("falls back to $HOME/.smithers when SMITHERS_HOME unset", () => {
        const env = { HOME: "/tmp/home" };
        expect(accountsRoot(env)).toBe("/tmp/home/.smithers");
    });
    test("treats empty SMITHERS_HOME as unset", () => {
        const env = { SMITHERS_HOME: "", HOME: "/tmp/home" };
        expect(accountsRoot(env)).toBe("/tmp/home/.smithers");
        expect(accountsFilePath(env)).toBe("/tmp/home/.smithers/accounts.json");
        expect(defaultConfigDir("foo", env)).toBe("/tmp/home/.smithers/accounts/foo");
    });
    test("rejects path-traversal labels", () => {
        const env = { SMITHERS_HOME: "/tmp/x" };
        for (const bad of ["../../../../etc", "..", "../foo", "foo/bar", "foo\\bar", "/abs", "", "  ", "a b", "a;b"]) {
            expect(() => defaultConfigDir(bad, env)).toThrow();
        }
    });
    test("accepts wizard-valid labels and keeps them under the smithers root", () => {
        const env = { SMITHERS_HOME: "/tmp/x" };
        expect(defaultConfigDir("claude-work", env)).toBe("/tmp/x/accounts/claude-work");
        expect(defaultConfigDir("Acct.1_2-3", env)).toBe("/tmp/x/accounts/Acct.1_2-3");
    });
});

describe("parseAccountsFile", () => {
    test("empty input returns empty registry", () => {
        expect(parseAccountsFile("")).toEqual({ version: 1, accounts: [] });
        expect(parseAccountsFile("   ")).toEqual({ version: 1, accounts: [] });
    });
    test("rejects non-JSON", () => {
        expect(() => parseAccountsFile("not json")).toThrow(/ACCOUNTS_FILE_INVALID|valid JSON/);
    });
    test("rejects wrong version", () => {
        expect(() => parseAccountsFile(JSON.stringify({ version: 99, accounts: [] })))
            .toThrow(/unsupported version/);
    });
    test("rejects invalid top-level and account shapes", () => {
        expect(() => parseAccountsFile("null")).toThrow(/must be a JSON object/);
        expect(() => parseAccountsFile(JSON.stringify({ version: 1, accounts: {} })))
            .toThrow(/accounts` must be an array/);
        expect(() => parseAccountsFile(JSON.stringify({ version: 1, accounts: [null] })))
            .toThrow(/accounts\[0\] must be an object/);
        expect(() => parseAccountsFile(JSON.stringify({ version: 1, accounts: [{ label: "", provider: "codex", configDir: "/x" }] })))
            .toThrow(/label must be a non-empty string/);
        expect(() => parseAccountsFile(JSON.stringify({ version: 1, accounts: [{ label: "x", provider: "nope" }] })))
            .toThrow(/provider must be one of/);
    });
    test("rejects missing configDir on subscription provider", () => {
        expect(() => parseAccountsFile(JSON.stringify({
            version: 1,
            accounts: [{ label: "x", provider: "claude-code" }],
        }))).toThrow(/configDir/);
    });
    test("rejects missing apiKey on api provider", () => {
        expect(() => parseAccountsFile(JSON.stringify({
            version: 1,
            accounts: [{ label: "x", provider: "openai-api" }],
        }))).toThrow(/apiKey/);
    });
    test("rejects entries with both configDir and apiKey", () => {
        expect(() => parseAccountsFile(JSON.stringify({
            version: 1,
            accounts: [{ label: "mixed", provider: "claude-code", configDir: "/p1", apiKey: "sk-leak" }],
        }))).toThrow(/configDir.*apiKey|apiKey.*configDir/);
    });
    test("rejects duplicate labels", () => {
        expect(() => parseAccountsFile(JSON.stringify({
            version: 1,
            accounts: [
                { label: "x", provider: "claude-code", configDir: "/a" },
                { label: "x", provider: "codex", configDir: "/b" },
            ],
        }))).toThrow(/duplicate label/);
    });
    test("accepts a valid file", () => {
        const parsed = parseAccountsFile(JSON.stringify({
            version: 1,
            accounts: [
                { label: "claude-work", provider: "claude-code", configDir: "/p1" },
                { label: "open-prod", provider: "openai-api", apiKey: "sk-xyz", model: "gpt-5" },
            ],
        }));
        expect(parsed.accounts).toHaveLength(2);
        expect(parsed.accounts[0].label).toBe("claude-work");
        expect(parsed.accounts[1].apiKey).toBe("sk-xyz");
    });
});

describe("readAccounts / writeAccounts / addAccount / removeAccount", () => {
    test("readAccounts returns empty when file missing", () => {
        const env = newSmithersHome();
        expect(readAccounts(env)).toEqual({ version: 1, accounts: [] });
        expect(listAccounts(env)).toEqual([]);
    });
    test("addAccount persists, then readAccounts retrieves it", () => {
        const env = newSmithersHome();
        const account = addAccount({
            label: "claude-work",
            provider: "claude-code",
            configDir: defaultConfigDir("claude-work", env),
        }, { env });
        expect(account.addedAt).toBeDefined();
        const list = listAccounts(env);
        expect(list).toHaveLength(1);
        expect(list[0].label).toBe("claude-work");
        expect(list[0].configDir).toContain("/accounts/claude-work");
    });
    test("addAccount rejects duplicate label by default; replace overrides", () => {
        const env = newSmithersHome();
        addAccount({
            label: "x", provider: "claude-code", configDir: "/a",
        }, { env });
        expect(() => addAccount({
            label: "x", provider: "claude-code", configDir: "/b",
        }, { env })).toThrow(/already exists/);
        const replaced = addAccount({
            label: "x", provider: "claude-code", configDir: "/c",
        }, { env, replace: true });
        expect(replaced.configDir).toBe("/c");
        expect(listAccounts(env)).toHaveLength(1);
    });
    test("addAccount preserves existing addedAt when replacing an account", () => {
        const env = newSmithersHome();
        const original = addAccount({
            label: "x",
            provider: "claude-code",
            configDir: "/a",
            addedAt: "2026-01-01T00:00:00.000Z",
        }, { env });
        const replaced = addAccount({
            label: "x",
            provider: "claude-code",
            configDir: "/b",
        }, { env, replace: true });
        expect(replaced.addedAt).toBe(original.addedAt);
        expect(listAccounts(env)[0].addedAt).toBe(original.addedAt);
    });
    test("addAccount accepts empty apiKey and persists api-provider models", () => {
        const env = newSmithersHome();
        const account = addAccount({
            label: "openai-env",
            provider: "openai-api",
            apiKey: "",
            model: "gpt-5",
        }, { env });
        expect(account.apiKey).toBe("");
        expect(account.model).toBe("gpt-5");
        expect(listAccounts(env)[0]).toMatchObject({
            label: "openai-env",
            provider: "openai-api",
            apiKey: "",
            model: "gpt-5",
        });
    });
    test("addAccount omits empty model strings", () => {
        const env = newSmithersHome();
        const account = addAccount({
            label: "openai-env",
            provider: "openai-api",
            apiKey: "sk",
            model: "",
        }, { env });
        expect(account).not.toHaveProperty("model");
        const raw = JSON.parse(readFileSync(accountsFilePath(env), "utf8"));
        expect(raw.accounts[0]).not.toHaveProperty("model");
    });
    test("addAccount validates provider/configDir/apiKey", () => {
        const env = newSmithersHome();
        expect(() => addAccount({ label: "", provider: "claude-code", configDir: "/x" }, { env }))
            .toThrow(/non-empty string/);
        expect(() => addAccount({ label: "bad", provider: "nope" }, { env }))
            .toThrow(/provider must be one of/);
        expect(() => addAccount({ label: "x", provider: "claude-code", configDir: "" }, { env }))
            .toThrow(/configDir/);
        expect(() => addAccount({ label: "y", provider: "openai-api" }, { env }))
            .toThrow(/apiKey/);
        expect(() => addAccount({ label: "mixed", provider: "claude-code", configDir: "/x", apiKey: "sk-leak" }, { env }))
            .toThrow(/configDir.*apiKey|apiKey.*configDir/);
    });
    test("removeAccount deletes by label; throws or no-ops for missing", () => {
        const env = newSmithersHome();
        addAccount({ label: "x", provider: "codex", configDir: "/a" }, { env });
        expect(removeAccount("x", { env })).toBe(true);
        expect(listAccounts(env)).toEqual([]);
        expect(() => removeAccount("x", { env })).toThrow(/No account/);
        expect(removeAccount("x", { env, silent: true })).toBe(false);
    });
    test("getAccount returns the right entry", () => {
        const env = newSmithersHome();
        addAccount({ label: "a", provider: "codex", configDir: "/a" }, { env });
        addAccount({ label: "b", provider: "claude-code", configDir: "/b" }, { env });
        expect(getAccount("a", env)?.provider).toBe("codex");
        expect(getAccount("b", env)?.provider).toBe("claude-code");
        expect(getAccount("missing", env)).toBeUndefined();
    });
    test("writeAccounts produces a mode-0600 file", () => {
        const env = newSmithersHome();
        writeAccounts({ version: 1, accounts: [] }, env);
        const stat = statSync(accountsFilePath(env));
        // Mask out file-type bits; we only care about permission bits.
        expect(stat.mode & 0o777).toBe(0o600);
    });
    test("ignores extra fields and preserves order", () => {
        const env = newSmithersHome();
        addAccount({ label: "first", provider: "codex", configDir: "/a" }, { env });
        addAccount({ label: "second", provider: "claude-code", configDir: "/b" }, { env });
        addAccount({ label: "third", provider: "openai-api", apiKey: "sk" }, { env });
        const labels = listAccounts(env).map((a) => a.label);
        expect(labels).toEqual(["first", "second", "third"]);
    });
    test("write+read round-trips via raw file", () => {
        const env = newSmithersHome();
        addAccount({ label: "x", provider: "kimi", configDir: "/p", model: "kimi-latest" }, { env });
        const raw = readFileSync(accountsFilePath(env), "utf8");
        const reparsed = parseAccountsFile(raw);
        expect(reparsed.accounts[0].model).toBe("kimi-latest");
    });
    test("survives a manually-corrupt file by surfacing a clear error", () => {
        const env = newSmithersHome();
        // Pre-create with invalid JSON
        const path = accountsFilePath(env);
        writeFileSync(path, "{not json", { encoding: "utf8", mode: 0o600 });
        expect(() => readAccounts(env)).toThrow(/ACCOUNTS_FILE_INVALID|valid JSON/);
    });
});

describe("accountToProviderEnv", () => {
    test("subscription providers map to their dir env var", () => {
        expect(accountToProviderEnv({ label: "x", provider: "claude-code", configDir: "/c" }))
            .toEqual({ CLAUDE_CONFIG_DIR: "/c" });
        expect(accountToProviderEnv({ label: "x", provider: "antigravity", configDir: "/c" }))
            .toEqual({ GEMINI_DIR: "/c" });
        expect(accountToProviderEnv({ label: "x", provider: "codex", configDir: "/c" }))
            .toEqual({ CODEX_HOME: "/c" });
        expect(accountToProviderEnv({ label: "x", provider: "gemini", configDir: "/c" }))
            .toEqual({ GEMINI_DIR: "/c" });
        expect(accountToProviderEnv({ label: "x", provider: "kimi", configDir: "/c" }))
            .toEqual({ KIMI_SHARE_DIR: "/c" });
    });
    test("api providers map to their api-key env var (or empty if no key)", () => {
        expect(accountToProviderEnv({ label: "x", provider: "openai-api", apiKey: "sk-1" }))
            .toEqual({ OPENAI_API_KEY: "sk-1" });
        expect(accountToProviderEnv({ label: "x", provider: "anthropic-api", apiKey: "sk-2" }))
            .toEqual({ ANTHROPIC_API_KEY: "sk-2" });
        expect(accountToProviderEnv({ label: "x", provider: "gemini-api", apiKey: "" }))
            .toEqual({});
    });
    test("subscription provider with missing configDir throws", () => {
        expect(() => accountToProviderEnv({ label: "x", provider: "claude-code" }))
            .toThrow(/missing configDir/);
        expect(() => accountToProviderEnv({ label: "x", provider: "antigravity" }))
            .toThrow(/missing configDir/);
        expect(() => accountToProviderEnv({ label: "x", provider: "codex" }))
            .toThrow(/missing configDir/);
        expect(() => accountToProviderEnv({ label: "x", provider: "gemini" }))
            .toThrow(/missing configDir/);
        expect(() => accountToProviderEnv({ label: "x", provider: "kimi" }))
            .toThrow(/missing configDir/);
    });
    test("unknown provider throws", () => {
        expect(() => accountToProviderEnv({ label: "x", provider: "nope" }))
            .toThrow(/unknown provider/);
    });
});
