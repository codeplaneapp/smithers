import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createExecutableDir, createTempRepo, runSmithers, writeFakeAntigravityBinary, writeFakeClaudeBinary, writeFakeCodexBinary, writeFakeOpenClawBinary, writeFakeOpenCodeBinary, } from "../../../packages/smithers/tests/e2e-helpers.js";
/**
 * @param {string} homeDir
 * @param {string} binDir
 * @param {Record<string, string>} [extra]
 */
function buildEnv(homeDir, binDir, extra = {}) {
    return {
        HOME: homeDir,
        CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
        CODEX_HOME: join(homeDir, ".codex"),
        GEMINI_DIR: join(homeDir, ".gemini"),
        KIMI_SHARE_DIR: join(homeDir, ".kimi"),
        PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        ...extra,
    };
}

function uncommented(source) {
    return source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
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
    expect(agentsSource).toMatch(/cheapFast:\s*\[\s*providers\.claudeSonnet,/);
    expect(agentsSource).toMatch(/smart:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,/);
    expect(agentsSource).toMatch(/smartTool:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,/);
    expect(uncommented(agentsSource)).not.toContain("providers.codex");
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
    expect(agentsSource).toMatch(/cheapFast:\s*\[\s*providers\.codex,/);
    expect(agentsSource).toMatch(/smart:\s*\[\s*providers\.codex,/);
    expect(agentsSource).toMatch(/smartTool:\s*\[\s*providers\.codex,/);
    expect(agentsSource).toContain("smart: Smithers would normally suggest Claude Code here");
    expect(agentsSource).toContain("cheapFast: Smithers would normally suggest Kimi here");
});
test("smithers init falls back to OpenRouter for OpenCode-only credentials", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeOpenCodeBinary(binDir);
    repo.write(".local/share/opencode/auth.json", JSON.stringify({ anthropic: { accessToken: "test" } }) + "\n");
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain("opencode: OpenCodeAgent");
    expect(agentsSource).toContain("openrouter: createOpenRouterAgent()");
    expect(agentsSource).toMatch(/smart:\s*\[\s*providers\.openrouter,/);
    expect(agentsSource).toMatch(/smartTool:\s*\[\s*providers\.openrouter,/);
});
test("smithers init can use OpenClaw as the only workflow agent", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeOpenClawBinary(binDir);
    repo.write(".openclaw/openclaw.json", JSON.stringify({ agents: { default: "main" } }) + "\n");
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain("OpenClawAgent as SmithersOpenClawAgent");
    expect(agentsSource).toContain("openclaw: new SmithersOpenClawAgent");
    expect(agentsSource).toMatch(/cheapFast:\s*\[\s*providers\.openclaw,/);
    expect(agentsSource).toMatch(/smart:\s*\[\s*providers\.openclaw,/);
    expect(agentsSource).toMatch(/smartTool:\s*\[\s*providers\.openclaw,/);
    expect(uncommented(agentsSource)).not.toContain("providers.claude");
    expect(uncommented(agentsSource)).not.toContain("providers.codex");
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
    expect(agentsSource).toMatch(/cheapFast:\s*\[\s*providers\.claudeSonnet,\s*providers\.antigravity,/);
    expect(agentsSource).toMatch(/smart:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,\s*providers\.codex,/);
    expect(agentsSource).toMatch(/smartTool:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,\s*providers\.codex,/);
    expect(uncommented(agentsSource)).not.toContain("providers.gemini");
});
test("smithers init emits OpenRouter default when no usable agents are detected", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    const active = uncommented(agentsSource);
    expect(agentsSource).toContain("openrouter: createOpenRouterAgent()");
    expect(agentsSource).toContain("OPENROUTER_API_KEY is not set");
    expect(agentsSource).toContain("//   claude: ClaudeCodeAgent,");
    expect(agentsSource).toContain("//   codex: CodexAgent,");
    expect(active).toContain("smart: [\n    providers.openrouter,");
    expect(active).toContain("smartTool: [\n    providers.openrouter,");
});

test("smithers init comments out a CLI that is present but not authenticated", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain("//   codex: CodexAgent,");
    expect(agentsSource).toContain("missing credentials");
    expect(agentsSource).toContain("OPENAI_API_KEY");
    expect(uncommented(agentsSource)).not.toContain("providers.codex");
});

test("smithers init comments out OpenCode CLI when it is present but not authenticated", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeOpenCodeBinary(binDir);
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain("//   opencode: OpenCodeAgent,");
    expect(agentsSource).toContain("// import { OpenCodeAgent } from \"./agents/opencode\";");
    expect(agentsSource).toContain("// export { OpenCodeAgent } from \"./agents/opencode\";");
    expect(uncommented(agentsSource)).not.toContain("providers.opencode");
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
    expect(untrusted.exitCode).toBe(0);
    repo.write(".gemini/trustedFolders.json", JSON.stringify({ [repo.dir]: "TRUST_FOLDER" }) + "\n");
    const trusted = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(trusted.exitCode).toBe(0);
    const agentsSource = repo.read(".smithers/agents.ts");
    expect(agentsSource).toContain("//   antigravity: AntigravityAgent,");
    expect(agentsSource).toContain("Antigravity");
    expect(agentsSource).not.toContain("Gemini");
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
