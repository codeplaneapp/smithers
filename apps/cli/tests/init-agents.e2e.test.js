import { expect, test } from "bun:test";
import { createExecutableDir, createTempRepo, runSmithers, writeFakeAntigravityBinary, writeFakeClaudeBinary, writeFakeCodexBinary, writeFakeGeminiBinary, writeFakeOpenCodeBinary, } from "../../../packages/smithers/tests/e2e-helpers.js";
/**
 * @param {string} homeDir
 * @param {string} binDir
 * @param {Record<string, string>} [extra]
 */
function buildEnv(homeDir, binDir, extra = {}) {
    return {
        HOME: homeDir,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
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
            OPENAI_API_KEY: "test-openai-key",
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
    repo.write(".local/share/opencode/auth.json", "{}\n");
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
    writeFakeGeminiBinary(binDir);
    repo.write(".claude/.credentials.json", "{}\n");
    repo.write(".codex/auth.json", "{}\n");
    repo.write(".local/share/opencode/auth.json", "{}\n");
    repo.write(".gemini/antigravity-cli/settings.json", "{}\n");
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
    expect(JSON.stringify(result.json)).toContain("gemini");
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

test("smithers init does not auto-select deprecated Gemini", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeGeminiBinary(binDir);
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
    expect(JSON.stringify(trusted.json)).toContain("deprecated");
    expect(JSON.stringify(trusted.json)).toContain("Antigravity");
});
