import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutableDir, createTempRepo, runSmithers, writeFakeClaudeBinary } from "../../../packages/smithers/tests/e2e-helpers.js";

/** @type {string[]} */
const tempDirs = [];
afterEach(() => {
    while (tempDirs.length) {
        const dir = tempDirs.pop();
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
});

function newSmithersHome() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-e2e-accounts-"));
    tempDirs.push(dir);
    return dir;
}

test("agents add (flag-driven) registers a subscription account and persists to ~/.smithers/accounts.json", () => {
    const repo = createTempRepo();
    const home = newSmithersHome();
    const result = runSmithers(
        ["agents", "add", "--provider", "claude-code", "--label", "claude-work", "--skip-login"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
        account: { label: "claude-work", provider: "claude-code" },
    });
    const accountsPath = join(home, "accounts.json");
    expect(existsSync(accountsPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(accountsPath, "utf8"));
    expect(persisted).toMatchObject({
        version: 1,
        accounts: [{ label: "claude-work", provider: "claude-code" }],
    });
    expect(persisted.accounts[0].configDir).toContain("/accounts/claude-work");
});

test("agents add for an api-key provider stores the key", () => {
    const repo = createTempRepo();
    const home = newSmithersHome();
    const result = runSmithers(
        ["agents", "add", "--provider", "openai-api", "--label", "openai-1", "--api-key", "sk-test123"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    expect(result.exitCode).toBe(0);
    const persisted = JSON.parse(readFileSync(join(home, "accounts.json"), "utf8"));
    expect(persisted.accounts[0]).toMatchObject({
        label: "openai-1",
        provider: "openai-api",
        apiKey: "sk-test123",
    });
});

test("agents add fails clearly when subscription dir is empty and --skip-login not passed", () => {
    const repo = createTempRepo();
    const home = newSmithersHome();
    const result = runSmithers(
        ["agents", "add", "--provider", "codex", "--label", "codex-1"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr + result.stdout).toContain("CODEX_HOME");
});

test("agents add with --replace overwrites the existing account", () => {
    const repo = createTempRepo();
    const home = newSmithersHome();
    runSmithers(
        ["agents", "add", "--provider", "claude-code", "--label", "x", "--config-dir", "/tmp/dir-a", "--skip-login"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    const dup = runSmithers(
        ["agents", "add", "--provider", "claude-code", "--label", "x", "--config-dir", "/tmp/dir-b", "--skip-login"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    expect(dup.exitCode).toBe(1);
    expect(dup.stderr + dup.stdout).toContain("already exists");
    const replaced = runSmithers(
        ["agents", "add", "--provider", "claude-code", "--label", "x", "--config-dir", "/tmp/dir-b", "--skip-login", "--replace"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    expect(replaced.exitCode).toBe(0);
    const persisted = JSON.parse(readFileSync(join(home, "accounts.json"), "utf8"));
    expect(persisted.accounts).toHaveLength(1);
    expect(persisted.accounts[0].configDir).toBe("/tmp/dir-b");
}, 15_000);

test("agents list emits JSON via --format json and a human table on stderr otherwise", () => {
    const repo = createTempRepo();
    const home = newSmithersHome();
    runSmithers(
        ["agents", "add", "--provider", "claude-code", "--label", "claude-1", "--skip-login"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    runSmithers(
        ["agents", "add", "--provider", "openai-api", "--label", "openai-1", "--api-key", "sk-x"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    const json = runSmithers(["agents", "list"], {
        cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home },
    });
    expect(json.exitCode).toBe(0);
    expect(json.json.accounts.map((a) => a.label).sort()).toEqual(["claude-1", "openai-1"]);
    const human = runSmithers(["agents", "list"], {
        cwd: repo.dir, format: null, env: { SMITHERS_HOME: home },
    });
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toContain("Registered accounts (2)");
    expect(human.stderr).toContain("claude-1");
    expect(human.stderr).toContain("openai-1");
}, 15_000);

test("agents remove deletes by label and is idempotent under --silent", () => {
    const repo = createTempRepo();
    const home = newSmithersHome();
    runSmithers(
        ["agents", "add", "--provider", "kimi", "--label", "kimi-1", "--skip-login"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    const removed = runSmithers(["agents", "remove", "kimi-1"], {
        cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home },
    });
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "accounts.json"), "utf8")).accounts).toEqual([]);
    const missing = runSmithers(["agents", "remove", "kimi-1"], {
        cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home },
    });
    expect(missing.exitCode).toBe(1);
    const silent = runSmithers(["agents", "remove", "kimi-1", "--silent"], {
        cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home },
    });
    expect(silent.exitCode).toBe(0);
}, 15_000);

test("agents add regenerates .smithers/agents.ts when one already exists", () => {
    const repo = createTempRepo();
    const home = newSmithersHome();
    // Pre-populate a generated agents.ts so the regen helper rewrites it.
    repo.write(".smithers/agents.ts", "// smithers-source: generated\n// (placeholder)\n");
    runSmithers(
        ["agents", "add", "--provider", "claude-code", "--label", "claude-work", "--skip-login"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    const regenerated = repo.read(".smithers/agents.ts");
    // The new account shows up as a provider…
    expect(regenerated).toContain("claudeWork: new SmithersClaudeCodeAgent(");
    // …and any tier pool whose preferred order references the `claude`
    // family (smart, smartTool) gets the account appended.
    expect(regenerated).toMatch(/smart(Tool)?: \[[^\]]*providers\.claudeWork[^\]]*\]/);
});

test("agents add does NOT overwrite a hand-edited agents.ts (no sentinel)", () => {
    const repo = createTempRepo();
    const home = newSmithersHome();
    const userContent = "// hand-rolled by the user\nexport const providers = {};\n";
    repo.write(".smithers/agents.ts", userContent);
    runSmithers(
        ["agents", "add", "--provider", "claude-code", "--label", "claude-work", "--skip-login"],
        { cwd: repo.dir, format: "json", env: { SMITHERS_HOME: home } },
    );
    expect(repo.read(".smithers/agents.ts")).toBe(userContent);
});

test("agents add appends to a detection-based agents.ts without dropping detected providers", () => {
    const repo = createTempRepo();
    const home = newSmithersHome();
    const binDir = createExecutableDir();
    const cleanBinDir = createExecutableDir("smithers-clean-bin-");
    writeFakeClaudeBinary(binDir);
    repo.write(".claude/.credentials.json", "{}\n");
    // First, run init with a fake API key so detection-based generation succeeds.
    const initResult = runSmithers(["init", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env: {
            HOME: repo.dir,
            PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
            SMITHERS_HOME: home,
            ANTHROPIC_API_KEY: "test",
            OPENAI_API_KEY: "",
        },
    });
    expect(initResult.exitCode).toBe(0);
    const initialAgentsTs = repo.read(".smithers/agents.ts");
    expect(initialAgentsTs).toContain("// smithers-source: generated");
    expect(initialAgentsTs).toContain("claude: ClaudeCodeAgent");
    // Now register an account and verify agents.ts adds the new provider
    // without removing the detected `claude` entry.
    runSmithers(
        ["agents", "add", "--provider", "codex", "--label", "codex-prod", "--skip-login"],
        {
            cwd: repo.dir,
            format: "json",
            env: {
                HOME: repo.dir,
                PATH: cleanBinDir,
                SMITHERS_HOME: home,
                ANTHROPIC_API_KEY: "",
                OPENAI_API_KEY: "",
            },
        },
    );
    const agentsTs = repo.read(".smithers/agents.ts");
    expect(agentsTs).toContain("~/.smithers/accounts.json");
    expect(agentsTs).toContain("codexProd: new SmithersCodexAgent(");
    // Detection-based provider survives the regen.
    expect(agentsTs).toContain("claude: ClaudeCodeAgent");
}, 20_000);
