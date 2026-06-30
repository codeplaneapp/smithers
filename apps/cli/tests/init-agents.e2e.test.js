import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createExecutableDir, createTempRepo, runSmithers, writeFakeAntigravityBinary, writeFakeClaudeBinary, writeFakeCodexBinary, writeFakeOpenCodeBinary, } from "../../../packages/smithers/tests/e2e-helpers.js";
/**
 * @param {string} homeDir
 * @param {string} binDir
 * @param {Record<string, string>} [extra]
 */
function buildEnv(homeDir, binDir, extra = {}) {
    return {
        HOME: homeDir,
        PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        ...extra,
    };
}
test("smithers init prefers Claude when only a Claude CLI signal is available", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeClaudeBinary(binDir);
    repo.write(".claude/.credentials.json", "{}\n");
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain('export { ClaudeCodeAgent } from "./agents/claude-code";');
    expect(agentsSource).toContain("claude: ClaudeCodeAgent");
    expect(agentsSource).toContain("cheapFast: [providers.claudeSonnet]");
    expect(agentsSource).toContain("smart: [providers.claude, providers.claudeOpus]");
    expect(agentsSource).toContain("smartTool: [providers.claude, providers.claudeOpus]");
    expect(agentsSource).not.toContain("providers.codex");
});
test("smithers init includes Codex implementation roles when Codex plus OPENAI_API_KEY are available", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir, {
            OPENAI_API_KEY: "sk-test-openai-key",
        }),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain('export { CodexAgent } from "./agents/codex";');
    expect(agentsSource).toContain("codex: CodexAgent");
    expect(agentsSource).toContain("cheapFast: [providers.codex]");
    expect(agentsSource).toContain("smart: [providers.codex]");
    expect(agentsSource).toContain("smartTool: [providers.codex]");
    expect(agentsSource).toContain("smart: Smithers would normally suggest Claude Code here");
    expect(agentsSource).toContain("cheapFast: Smithers would normally suggest Kimi here");
});
test("smithers init rejects OpenCode-only credentials because default smart pools would be empty", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeOpenCodeBinary(binDir);
    repo.write(".local/share/opencode/auth.json", JSON.stringify({ anthropic: { accessToken: "test" } }) + "\n");
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(4);
    expect(result.json).toMatchObject({
        code: "NO_USABLE_AGENTS",
    });
    expect(JSON.stringify(result.json)).toContain("required default pools");
    expect(JSON.stringify(result.json)).toContain("smart");
    expect(JSON.stringify(result.json)).toContain("smartTool");
});
test("smithers init orders role chains correctly when multiple local agent CLIs are available", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeClaudeBinary(binDir);
    writeFakeCodexBinary(binDir);
    writeFakeOpenCodeBinary(binDir);
    writeFakeAntigravityBinary(binDir);
    repo.write(".claude/.credentials.json", "{}\n");
    repo.write(".codex/auth.json", JSON.stringify({ tokens: { access_token: "test" } }) + "\n");
    repo.write(".local/share/opencode/auth.json", JSON.stringify({ anthropic: { accessToken: "test" } }) + "\n");
    repo.write(".gemini/antigravity-cli/settings.json", JSON.stringify({ signedIn: true }) + "\n");
    repo.write(".gemini/oauth_creds.json", "{}\n");
    repo.write(".gemini/trustedFolders.json", JSON.stringify({ [repo.dir]: "TRUST_FOLDER" }) + "\n");
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain("cheapFast: [providers.claudeSonnet, providers.antigravity]");
    expect(agentsSource).toContain("smart: [providers.claude, providers.claudeOpus, providers.codex]");
    expect(agentsSource).toContain("smartTool: [providers.claude, providers.claudeOpus, providers.codex]");
    expect(agentsSource).not.toContain("providers.gemini");
});
test("smithers init exits with a typed error when no usable agents are detected", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(4);
    expect(result.json).toMatchObject({
        code: "NO_USABLE_AGENTS",
    });
    expect(JSON.stringify(result.json)).toContain("claude");
    expect(JSON.stringify(result.json)).toContain("codex");
    expect(JSON.stringify(result.json)).toContain("opencode");
    expect(JSON.stringify(result.json)).toContain("antigravity");
    expect(JSON.stringify(result.json)).not.toContain("Gemini");
    expect(JSON.stringify(result.json)).toContain("codex login");
});

test("smithers init rejects a CLI that is present but not authenticated", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(4);
    expect(result.json).toMatchObject({
        code: "NO_USABLE_AGENTS",
    });
    expect(JSON.stringify(result.json)).toContain("missing credentials");
    expect(JSON.stringify(result.json)).toContain("OPENAI_API_KEY");
});

test("smithers init rejects OpenCode CLI when it is present but not authenticated", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeOpenCodeBinary(binDir);
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(4);
    expect(result.json).toMatchObject({
        code: "NO_USABLE_AGENTS",
    });
    expect(JSON.stringify(result.json)).toContain("OpenCode");
    expect(JSON.stringify(result.json)).toContain("missing credentials");
    expect(JSON.stringify(result.json)).toContain("opencode/auth.json");
});

test("smithers init ignores old Gemini CLI credentials", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    repo.write(".gemini/oauth_creds.json", "{}\n");
    const untrusted = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(untrusted.exitCode).toBe(4);
    repo.write(".gemini/trustedFolders.json", JSON.stringify({ [repo.dir]: "TRUST_FOLDER" }) + "\n");
    const trusted = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(trusted.exitCode).toBe(4);
    expect(JSON.stringify(trusted.json)).toContain("Antigravity");
    expect(JSON.stringify(trusted.json)).not.toContain("Gemini");
});
test("smithers init does not crash when a Hermes agent is detected (regression)", () => {
    // Regression: a detected `hermes` agent used to crash agents.ts generation
    // with `CONSTRUCTORS[provider.id].importName` because the detector shipped
    // without a constructor mapping. `init` must succeed and scaffold a
    // HermesCliAgent provider.
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeClaudeBinary(binDir); // a usable base agent so we hit the detection path
    repo.write(".claude/.credentials.json", "{}\n");
    // Fake a Hermes install: binary on PATH + ~/.hermes auth signal.
    writeFileSync(join(binDir, "hermes"), [
        "#!/bin/sh",
        "if [ \"$1\" = \"status\" ]; then",
        "  printf 'Provider: OpenRouter\\nKimi / Moonshot  ✓ configured\\n'",
        "  exit 0",
        "fi",
        "exit 0",
        "",
    ].join("\n"));
    chmodSync(join(binDir, "hermes"), 0o755);
    mkdirSync(join(repo.dir, ".hermes"), { recursive: true });
    writeFileSync(join(repo.dir, ".hermes", "config.yaml"), "model: hermes\n");
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain("HermesCliAgent");
    expect(agentsSource).toContain("hermes: new SmithersHermesCliAgent");
});
test("smithers init survives a legacy unknown provider account (regression)", () => {
    // Regression: published 0.26.0 crashed `smithers init` with
    // `undefined is not an object (evaluating CONSTRUCTORS[provider.id].importName)`
    // when ~/.smithers/accounts.json held an account whose provider id was the
    // old `gemini` (renamed to `gemini-api`). The legacy entry must be
    // warn-and-skipped at the parse layer, so init still exits 0 and scaffolds
    // agents.ts without leaking a `Smithersundefined` provider line.
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    // A usable base agent so detection succeeds and we reach generation.
    writeFakeClaudeBinary(binDir);
    repo.write(".claude/.credentials.json", "{}\n");
    // Legacy account at $HOME/.smithers/accounts.json (HOME === repo.dir here).
    repo.write(".smithers/accounts.json", JSON.stringify({
        version: 1,
        accounts: [
            {
                label: "my-gemini",
                provider: "gemini",
                configDir: join(repo.dir, ".gemini"),
                model: "gemini-2.0",
            },
        ],
    }) + "\n");
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain("claude: ClaudeCodeAgent");
    // The legacy account must not leak into the generated providers map.
    expect(agentsSource).not.toContain("Smithersundefined");
    expect(agentsSource).not.toContain("my-gemini");
    expect(agentsSource).not.toContain("myGemini");
});
