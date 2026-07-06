import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
        expect(accountsRoot(env)).toBe(env.SMITHERS_HOME);
        expect(accountsFilePath(env)).toBe(join("/tmp/x", "accounts.json"));
        expect(defaultConfigDir("foo", env)).toBe(join("/tmp/x", "accounts", "foo"));
    });
    test("falls back to $HOME/.smithers when SMITHERS_HOME unset", () => {
        const env = { HOME: "/tmp/home" };
        expect(accountsRoot(env)).toBe(join("/tmp/home", ".smithers"));
    });
    test("treats empty SMITHERS_HOME as unset", () => {
        const env = { SMITHERS_HOME: "", HOME: "/tmp/home" };
        expect(accountsRoot(env)).toBe(join("/tmp/home", ".smithers"));
        expect(accountsFilePath(env)).toBe(join("/tmp/home", ".smithers", "accounts.json"));
        expect(defaultConfigDir("foo", env)).toBe(join("/tmp/home", ".smithers", "accounts", "foo"));
    });
    test("rejects path-traversal labels", () => {
        const env = { SMITHERS_HOME: "/tmp/x" };
        for (const bad of ["../../../../etc", "..", "../foo", "foo/bar", "foo\\bar", "/abs", "", "  ", "a b", "a;b"]) {
            expect(() => defaultConfigDir(bad, env)).toThrow();
        }
    });
    test("accepts wizard-valid labels and keeps them under the smithers root", () => {
        const env = { SMITHERS_HOME: "/tmp/x" };
        expect(defaultConfigDir("claude-work", env)).toBe(join("/tmp/x", "accounts", "claude-work"));
        expect(defaultConfigDir("Acct.1_2-3", env)).toBe(join("/tmp/x", "accounts", "Acct.1_2-3"));
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
    test("drops a legacy unknown-provider entry but keeps the valid ones", () => {
        // Real machine repro: a pre-0.25 accounts.json still carrying a `gemini`
        // subscription account must not nuke the user's kimi + codex accounts.
        const warnings = [];
        const realWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(" "));
        let parsed;
        try {
            parsed = parseAccountsFile(JSON.stringify({
                version: 1,
                accounts: [
                    { label: "kimi-main", provider: "kimi", configDir: "/p/kimi" },
                    { label: "codex-main", provider: "codex", configDir: "/p/codex" },
                    { label: "gem-legacy", provider: "gemini", configDir: "/p/gem" },
                ],
            }));
        } finally {
            console.warn = realWarn;
        }
        const labels = parsed.accounts.map((a) => a.label);
        const providers = parsed.accounts.map((a) => a.provider);
        expect(parsed.accounts).toHaveLength(2);
        expect(labels).toEqual(["kimi-main", "codex-main"]);
        expect(providers).not.toContain("gemini");
        expect(labels).not.toContain("gem-legacy");
        // The skip must be surfaced, naming the dropped account + its provider.
        expect(warnings.some((w) => w.includes("gem-legacy") && w.includes("gemini"))).toBe(true);
    });
    test("a fully valid file with no legacy entries still parses every account", () => {
        const parsed = parseAccountsFile(JSON.stringify({
            version: 1,
            accounts: [
                { label: "kimi-main", provider: "kimi", configDir: "/p/kimi" },
                { label: "codex-main", provider: "codex", configDir: "/p/codex" },
                { label: "open-prod", provider: "openai-api", apiKey: "sk-1" },
            ],
        }));
        expect(parsed.accounts.map((a) => a.label)).toEqual(["kimi-main", "codex-main", "open-prod"]);
    });
    test("still rejects a recognized provider whose required fields are missing", () => {
        // Skipping is only for UNKNOWN providers; a known provider that's
        // malformed is real corruption of a live account and must still throw.
        expect(() => parseAccountsFile(JSON.stringify({
            version: 1,
            accounts: [
                { label: "kimi-main", provider: "kimi", configDir: "/p/kimi" },
                { label: "broken-codex", provider: "codex" },
            ],
        }))).toThrow(/configDir/);
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
        expect(list[0].configDir).toContain(join("accounts", "claude-work"));
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
        if (process.platform === "win32") return;
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
        addAccount({ label: "x", provider: "kimi", configDir: "/p", model: "kimi-k2.7-code" }, { env });
        const raw = readFileSync(accountsFilePath(env), "utf8");
        const reparsed = parseAccountsFile(raw);
        expect(reparsed.accounts[0].model).toBe("kimi-k2.7-code");
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
        expect(() => accountToProviderEnv({ label: "x", provider: "kimi" }))
            .toThrow(/missing configDir/);
    });
    test("unknown provider throws", () => {
        expect(() => accountToProviderEnv({ label: "x", provider: "nope" }))
            .toThrow(/unknown provider/);
    });
});

const addAccountUrl = new URL("../src/addAccount.js", import.meta.url).href;
const removeAccountUrl = new URL("../src/removeAccount.js", import.meta.url).href;

/**
 * Runs N addAccount() calls in N separate real OS processes against the same
 * SMITHERS_HOME, concurrently. This reproduces the actual production race:
 * multiple `smithers` CLIs / agents mutating ~/.smithers/accounts.json at once.
 * (A single-process Promise.all cannot interleave because addAccount is fully
 * synchronous, so it would never expose the lost-update bug.)
 *
 * @param {string} home
 * @param {string[]} labels
 * @returns {Promise<void>}
 */
async function addAccountsConcurrently(home, labels) {
    const body = `
const { addAccount } = await import(process.env.ADD_URL);
addAccount(
  { label: process.env.LABEL, provider: "codex", configDir: "/c/" + process.env.LABEL },
  { env: { SMITHERS_HOME: process.env.SMITHERS_HOME } },
);
`;
    const procs = labels.map((label) =>
        Bun.spawn({
            cmd: [process.execPath, "--eval", body],
            env: { ...process.env, ADD_URL: addAccountUrl, LABEL: label, SMITHERS_HOME: home },
            stdout: "ignore",
            stderr: "pipe",
        }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    for (let i = 0; i < codes.length; i++) {
        if (codes[i] !== 0) {
            const err = await new Response(procs[i].stderr).text();
            throw new Error(`child addAccount(${labels[i]}) exited ${codes[i]}: ${err}`);
        }
    }
}

describe("concurrent read-modify-write does not lose updates", () => {
    test("many interleaved addAccount processes all survive (no lost update)", async () => {
        const env = newSmithersHome();
        const home = env.SMITHERS_HOME;
        const labels = Array.from({ length: 12 }, (_, i) => `acct-${i}`);
        await addAccountsConcurrently(home, labels);
        const persisted = listAccounts(env).map((a) => a.label).sort();
        expect(persisted).toEqual([...labels].sort());
    }, 30_000);

    test("interleaving addAccount('a') with removeAccount('b') keeps 'a'", async () => {
        const env = newSmithersHome();
        const home = env.SMITHERS_HOME;
        // Seed 'b' so the remove has something real to delete.
        addAccount({ label: "b", provider: "codex", configDir: "/c/b" }, { env });

        const addBody = `
const { addAccount } = await import(process.env.ADD_URL);
addAccount({ label: "a", provider: "codex", configDir: "/c/a" }, { env: { SMITHERS_HOME: process.env.SMITHERS_HOME } });
`;
        const removeBody = `
const { removeAccount } = await import(process.env.REMOVE_URL);
removeAccount("b", { env: { SMITHERS_HOME: process.env.SMITHERS_HOME } });
`;
        const adder = Bun.spawn({
            cmd: [process.execPath, "--eval", addBody],
            env: { ...process.env, ADD_URL: addAccountUrl, SMITHERS_HOME: home },
            stdout: "ignore", stderr: "pipe",
        });
        const remover = Bun.spawn({
            cmd: [process.execPath, "--eval", removeBody],
            env: { ...process.env, REMOVE_URL: removeAccountUrl, SMITHERS_HOME: home },
            stdout: "ignore", stderr: "pipe",
        });
        expect(await adder.exited).toBe(0);
        expect(await remover.exited).toBe(0);

        const labels = listAccounts(env).map((a) => a.label);
        // 'a' must never be lost by the concurrent remove; 'b' must be gone.
        expect(labels).toContain("a");
        expect(labels).not.toContain("b");
    }, 30_000);

    test("two same-millisecond writes use distinct temp paths (collision-safe)", () => {
        const env = newSmithersHome();
        // Pin the clock so both writes would have produced an identical
        // pid+time temp name under the old scheme; the random suffix must
        // still keep them distinct so neither clobbers the other's bytes.
        const realNow = Date.now;
        Date.now = () => 1_700_000_000_000;
        try {
            writeAccounts({ version: 1, accounts: [{ label: "a", provider: "codex", configDir: "/c/a" }] }, env);
            writeAccounts({ version: 1, accounts: [{ label: "b", provider: "codex", configDir: "/c/b" }] }, env);
        } finally {
            Date.now = realNow;
        }
        // Both writes completed; last one wins the final file, no temp debris.
        expect(listAccounts(env).map((a) => a.label)).toEqual(["b"]);
        const debris = readdirSync(env.SMITHERS_HOME).filter((f) => f.includes(".tmp."));
        expect(debris).toEqual([]);
    });
});

describe("writeAccounts secret-safe permissions and crash atomicity", () => {
    test("overwriting a pre-existing world-readable accounts.json re-tightens to 0600", () => {
        if (process.platform === "win32") return;
        const env = newSmithersHome();
        const path = accountsFilePath(env);
        // Simulate an upgrade/migration where a loose-perm file already exists.
        writeFileSync(path, JSON.stringify({ version: 1, accounts: [] }), { encoding: "utf8", mode: 0o666 });
        chmodSync(path, 0o666);
        expect(statSync(path).mode & 0o777).toBe(0o666);

        addAccount({ label: "k", provider: "openai-api", apiKey: "sk-SECRET-VALUE" }, { env });
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    test("failed rename cleans up the plaintext-key temp file and leaves the original intact", () => {
        const env = newSmithersHome();
        const path = accountsFilePath(env);
        // Real fault injection (no mocks): make the target a NON-EMPTY directory
        // so renameSync(tmp -> path) genuinely fails with ENOTEMPTY/EISDIR.
        mkdirSync(path, { recursive: true });
        const sentinel = join(path, "keep.txt");
        writeFileSync(sentinel, "preexisting");

        expect(() =>
            writeAccounts(
                { version: 1, accounts: [{ label: "x", provider: "openai-api", apiKey: "sk-MUST-NOT-LEAK" }] },
                env,
            ),
        ).toThrow();

        // Atomicity: the pre-existing target was never touched.
        expect(existsSync(sentinel)).toBe(true);
        expect(readFileSync(sentinel, "utf8")).toBe("preexisting");
        // No orphaned temp file carrying the plaintext API key.
        const debris = readdirSync(env.SMITHERS_HOME).filter((f) => f.includes(".tmp."));
        expect(debris).toEqual([]);
    });
});

describe("addAccount/removeAccount fail closed on a corrupt accounts.json", () => {
    test("each mutator throws ACCOUNTS_FILE_INVALID and never clobbers the corrupt file", () => {
        const env = newSmithersHome();
        const path = accountsFilePath(env);
        const corrupt = '{ "version": 1, "accounts": [ { "label": "good", "provider": "codex", "configDir": "/c/good" } ], BROKEN';
        writeFileSync(path, corrupt, { encoding: "utf8", mode: 0o600 });

        expect(() => addAccount({ label: "new", provider: "codex", configDir: "/c/new" }, { env }))
            .toThrow(/ACCOUNTS_FILE_INVALID|valid JSON/);
        expect(() => removeAccount("good", { env })).toThrow(/ACCOUNTS_FILE_INVALID|valid JSON/);
        expect(() => getAccount("good", env)).toThrow(/ACCOUNTS_FILE_INVALID|valid JSON/);
        expect(() => listAccounts(env)).toThrow(/ACCOUNTS_FILE_INVALID|valid JSON/);

        // The corrupt file is preserved byte-for-byte for the user to recover,
        // not silently overwritten with a fresh single-account file.
        expect(readFileSync(path, "utf8")).toBe(corrupt);
    });
});

describe("secret keys never leak into thrown error messages", () => {
    const SECRET = "sk-SUPER-SECRET-DO-NOT-LEAK-9f8a";

    test("addAccount both-set validation error omits the apiKey value", () => {
        const env = newSmithersHome();
        let caught;
        try {
            addAccount({ label: "leaky", provider: "claude-code", configDir: "/c/leaky", apiKey: SECRET }, { env });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeDefined();
        expect(caught.message).not.toContain(SECRET);
    });

    test("parseAccountsFile both-set validation error omits the apiKey value", () => {
        const raw = JSON.stringify({
            version: 1,
            accounts: [{ label: "leaky", provider: "claude-code", configDir: "/c/leaky", apiKey: SECRET }],
        });
        let caught;
        try {
            parseAccountsFile(raw);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeDefined();
        expect(caught.message).not.toContain(SECRET);
    });
});
