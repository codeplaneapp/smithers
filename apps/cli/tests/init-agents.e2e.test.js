import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { parseManifest } from "../src/manifest.js";
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

const CODEX_DEFAULT_TIERS = {
    cheapFast: "Luna",
    research: "Luna",
    implement: "Luna",
    midTier: "Terra",
    smartTool: "Terra",
    validate: "Terra",
    smart: "Sol",
    review: "Sol",
    planning: "Sol",
    orchestrator: "Sol",
};

function activePoolProviders(source, pool) {
    const match = uncommented(source).match(new RegExp(`(?:^|\\n)  ${pool}: \\[([\\s\\S]*?)\\n  \\],`));
    expect(match, `missing generated ${pool} pool`).toBeTruthy();
    return [...match[1].matchAll(/providers\.([A-Za-z_$][\w$]*)/g)].map((entry) => entry[1]);
}

function expectCodexFirstDefaultTiers(source, providerPrefix = "codex") {
    for (const [tier, modelTier] of Object.entries(CODEX_DEFAULT_TIERS)) {
        expect(activePoolProviders(source, tier)[0], `${tier} must start with Codex`).toBe(
            `${providerPrefix}${modelTier}`,
        );
    }
}

function expectSingleProviderFallback(source, providerId) {
    for (const tier of Object.keys(CODEX_DEFAULT_TIERS)) {
        expect(activePoolProviders(source, tier), `${tier} should use the available fallback`).toEqual([providerId]);
    }
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
    expect(agentsSource).toContain("claude: new SmithersClaudeCodeAgent(");
    expect(agentsSource).toMatch(/cheapFast:\s*\[\s*providers\.claudeSonnet,/);
    expect(agentsSource).toMatch(/smart:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,/);
    expect(agentsSource).toMatch(/smartTool:\s*\[\s*providers\.claudeSonnet,/);
    expect(agentsSource).toMatch(/review:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,/);
    expect(agentsSource).toMatch(/research:\s*\[\s*providers\.claudeSonnet,/);
    expect(agentsSource).toMatch(/implement:\s*\[\s*providers\.claudeSonnet,/);
    expect(agentsSource).toMatch(/midTier:\s*\[\s*providers\.claudeSonnet,/);
    expect(agentsSource).toMatch(/validate:\s*\[\s*providers\.claudeSonnet,/);
    expect(agentsSource).toMatch(/planning:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,/);
    expect(agentsSource).toMatch(/orchestrator:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,/);
    expect(uncommented(agentsSource)).not.toContain("providers.codex");
});
test("smithers init routes every default tier to its Codex 5.6 model", () => {
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
    expect(agentsSource).toContain("codex: new SmithersCodexAgent(");
    expect(agentsSource).toContain('codexSol: new SmithersCodexAgent({ model: "gpt-5.6-sol"');
    expect(agentsSource).toContain('codexTerra: new SmithersCodexAgent({ model: "gpt-5.6-terra"');
    expect(agentsSource).toContain('codexLuna: new SmithersCodexAgent({ model: "gpt-5.6-luna"');
    expectCodexFirstDefaultTiers(agentsSource);
    expect(agentsSource).toContain("Codex runs first. Later entries are runtime fallbacks");
});

test("smithers init --agents-only still scaffolds the pack manifest", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    const result = runSmithers(["init", "--agents-only"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir, { OPENAI_API_KEY: "sk-test-openai-key" }),
    });
    expect(result.exitCode).toBe(0);
    // Every .smithers is a publishable pack, even when only agent scaffolds
    // are installed — the manifest must exist with empty contents.
    const manifest = parseManifest(repo.read(".smithers/smithers.toon"));
    expect(manifest.name).toBe(basename(repo.dir));
    expect(manifest.contents.workflows).toEqual([]);
    expect(manifest.contents.ui).toEqual([]);
    expect(manifest.capabilities.writes).toBe("none");
});

test("re-init preserves a customized legacy scaffold while repairing generated Worktree defaults", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    const env = buildEnv(repo.dir, binDir, { OPENAI_API_KEY: "sk-test-openai-key" });

    const first = runSmithers(["init", "--agents-only"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(first.exitCode).toBe(0);

    const customizedLegacyScaffold = [
        'import { CodexAgent as BaseCodexAgent } from "smithers-orchestrator";',
        "export const CodexAgent = new BaseCodexAgent({",
        '  model: "gpt-5.4",',
        "  cwd: process.cwd(),",
        "});",
        "// user customization must survive re-init",
        "",
    ].join("\n");
    repo.write(".smithers/agents/codex.ts", customizedLegacyScaffold);
    repo.write(".smithers/agents.ts", [
        "// smithers-source: generated",
        'import { CodexAgent } from "./agents/codex";',
        "export const providers = {",
        "  codex: CodexAgent,",
        "} as const;",
        "",
    ].join("\n"));

    const second = runSmithers(["init", "--agents-only"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(second.exitCode).toBe(0);
    expect(repo.read(".smithers/agents/codex.ts")).toBe(customizedLegacyScaffold);

    const regenerated = repo.read(".smithers/agents.ts");
    expect(regenerated).toContain("codex: new SmithersCodexAgent(");
    expect(regenerated).toContain("codexSol: new SmithersCodexAgent(");
    expect(regenerated).toContain("codexTerra: new SmithersCodexAgent(");
    expect(regenerated).toContain("codexLuna: new SmithersCodexAgent(");
    expect(uncommented(regenerated)).not.toContain("codex: CodexAgent");
    expect(uncommented(regenerated)).not.toContain("cwd: process.cwd()");
}, 30_000);

test("smithers init uses OpenCode for OpenCode-only credentials", () => {
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
    const active = uncommented(agentsSource);
    expect(agentsSource).toContain("opencode: new SmithersOpenCodeAgent(");
    expect(active).toMatch(/cheapFast:\s*\[\s*providers\.opencode,/);
    expect(active).toMatch(/smart:\s*\[\s*providers\.opencode,/);
    expect(active).toMatch(/smartTool:\s*\[\s*providers\.opencode,/);
    expect(active).toMatch(/review:\s*\[\s*providers\.opencode,/);
    expectSingleProviderFallback(agentsSource, "opencode");
    expect(active).not.toContain("openrouter: createOpenRouterAgent()");
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
    expect(agentsSource).toMatch(/review:\s*\[\s*providers\.openclaw,/);
    expectSingleProviderFallback(agentsSource, "openclaw");
    expect(uncommented(agentsSource)).not.toContain("providers.claude");
    expect(uncommented(agentsSource)).not.toContain("providers.codex");
});
test("smithers init keeps Codex first and other local CLIs as runtime fallbacks", () => {
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
    expectCodexFirstDefaultTiers(agentsSource);
    expect(activePoolProviders(agentsSource, "implement").slice(1)).toEqual([
        "claudeSonnet",
        "antigravity",
        "claude",
    ]);
    expect(activePoolProviders(agentsSource, "review").slice(1)).toEqual([
        "claude",
        "claudeOpus",
        "claudeSonnet",
    ]);
});

test("smithers init creates role-specific Sol, Terra, and Luna variants for a Codex account", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    repo.write(".smithers/accounts.json", JSON.stringify({
        version: 1,
        accounts: [
            {
                label: "codex-work",
                provider: "codex",
                configDir: join(repo.dir, ".smithers", "accounts", "codex-work"),
                model: "gpt-5.4",
                addedAt: "2026-07-09T00:00:00.000Z",
            },
            {
                label: "claude-backup",
                provider: "claude-code",
                configDir: join(repo.dir, ".smithers", "accounts", "claude-backup"),
                addedAt: "2026-07-09T00:00:00.000Z",
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
    expect(agentsSource).toContain('codexWork: new SmithersCodexAgent({ model: "gpt-5.4"');
    expect(agentsSource).toContain('codexWorkSol: new SmithersCodexAgent({ model: "gpt-5.6-sol"');
    expect(agentsSource).toContain('codexWorkTerra: new SmithersCodexAgent({ model: "gpt-5.6-terra"');
    expect(agentsSource).toContain('codexWorkLuna: new SmithersCodexAgent({ model: "gpt-5.6-luna"');
    expectCodexFirstDefaultTiers(agentsSource, "codexWork");
    for (const tier of Object.keys(CODEX_DEFAULT_TIERS)) {
        expect(activePoolProviders(agentsSource, tier)).toContain("claudeBackup");
    }
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
    expect(agentsSource).toContain("//   claude: new SmithersClaudeCodeAgent(");
    expect(agentsSource).toContain("//   codex: new SmithersCodexAgent(");
    expect(active).toContain("smart: [\n    providers.openrouter,");
    expect(active).toContain("smartTool: [\n    providers.openrouter,");
    expect(active).toContain("review: [\n    providers.openrouter,");
    expectSingleProviderFallback(agentsSource, "openrouter");
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
    expect(agentsSource).toContain("//   codex: new SmithersCodexAgent(");
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
    expect(agentsSource).toContain("//   opencode: new SmithersOpenCodeAgent(");
    expect(agentsSource).toContain("// import { OpenCodeAgent as SmithersOpenCodeAgent } from \"smithers-orchestrator\";");
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
    expect(agentsSource).toContain("//   antigravity: new SmithersAntigravityAgent(),");
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
    expect(agentsSource).toContain("claude: new SmithersClaudeCodeAgent(");
    // The legacy account must not leak into the generated providers map.
    expect(agentsSource).not.toContain("Smithersundefined");
    expect(agentsSource).not.toContain("my-gemini");
    expect(agentsSource).not.toContain("myGemini");
});

test("smithers init \"<task>\" --agents-only fails with a create-workflow hint, not a raw RUN_NOT_FOUND", () => {
    // A prompt is an explicit request for the create-workflow builder, but
    // --agents-only installs no workflows, so the post-init dispatch can't find
    // it. The failure must guide the user (re-run without --agents-only / keep
    // create-workflow selected) instead of surfacing the bare "Workflow not
    // found: create-workflow". HOME === repo.dir here, so no global pack masks it.
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeClaudeBinary(binDir);
    repo.write(".claude/.credentials.json", "{}\n");
    const result = runSmithers(["init", "build a docs-sync workflow", "--agents-only"], {
        cwd: repo.dir,
        format: "json",
        env: buildEnv(repo.dir, binDir),
    });
    expect(result.exitCode).not.toBe(0);
    const all = `${result.stdout}\n${result.stderr}`;
    expect(all).toContain("create-workflow is not installed");
    // The raw framework message must NOT be the whole story.
    expect(all).not.toMatch(/^Workflow not found: create-workflow$/m);
});
