import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { addAccount } from "@smithers-orchestrator/accounts";
import { extractGeneratedDetectionProviderIds, generateAgentsTs } from "../src/agent-detection.js";
import { createExecutableDir, writeFakeClaudeBinary } from "../../../packages/smithers/tests/e2e-helpers.js";

/** @type {string[]} */
const tempDirs = [];
afterEach(() => {
    while (tempDirs.length) {
        const dir = tempDirs.pop();
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
});

function newSmithersHome() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-codegen-"));
    tempDirs.push(dir);
    return { SMITHERS_HOME: dir, HOME: dir };
}

function uncommented(source) {
    return source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
}

describe("generateAgentsTs (account-driven)", () => {
    test("emits one provider per account and a pool per engine family", () => {
        const env = newSmithersHome();
        addAccount({ label: "claude-work", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-work` }, { env });
        addAccount({ label: "claude-personal", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-personal` }, { env });
        addAccount({ label: "codex-work", provider: "codex", configDir: `${env.HOME}/.smithers/accounts/codex-work` }, { env });
        const generated = generateAgentsTs(env);
        // sentinel + ledger pointer
        expect(generated).toContain("// smithers-source: generated");
        expect(generated).toContain("~/.smithers/accounts.json");
        // imports the SDK class once per used engine
        expect(generated).toContain("ClaudeCodeAgent as SmithersClaudeCodeAgent");
        expect(generated).toContain("CodexAgent as SmithersCodexAgent");
        // one provider per account, camel-cased label
        expect(generated).toContain("claudeWork: new SmithersClaudeCodeAgent(");
        expect(generated).toContain("claudePersonal: new SmithersClaudeCodeAgent(");
        expect(generated).toContain("codexWork: new SmithersCodexAgent(");
        // pools group by engine family
        expect(generated).toMatch(/claude:\s*\[\s*providers\.claudeWork,\s*providers\.claudePersonal,\s*\]/);
        expect(generated).toMatch(/codex:\s*\[\s*providers\.codexWork,\s*\]/);
        // Smart pools lead with subscription Claude so failover is not on the hot path.
        expect(generated).toMatch(/smart:\s*\[\s*providers\.claudeWork,\s*providers\.claudePersonal,\s*providers\.codexWork,/);
        expect(generated).toMatch(/smartTool:\s*\[\s*providers\.claudeWork,\s*providers\.claudePersonal,\s*providers\.codexWork,/);
        expect(generated).toMatch(/review:\s*\[\s*providers\.claudeWork,\s*providers\.claudePersonal,\s*providers\.codexWork,/);
    });

    test("path.join(homedir(), ...) is used for paths under $HOME", () => {
        const env = newSmithersHome();
        addAccount({ label: "claude-x", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-x` }, { env });
        const generated = generateAgentsTs(env);
        expect(generated).toContain('import { homedir } from "node:os"');
        expect(generated).toContain('import path from "node:path"');
        expect(generated).toContain('configDir: path.join(homedir(), ".smithers/accounts/claude-x")');
        // and never the absolute path leaked literally
        expect(generated).not.toContain(env.HOME + "/.smithers/accounts/claude-x");
    });

    test("absolute path outside $HOME is preserved verbatim", () => {
        const env = newSmithersHome();
        addAccount({ label: "claude-custom", provider: "claude-code", configDir: "/opt/shared/claude" }, { env });
        const generated = generateAgentsTs(env);
        expect(generated).toContain('configDir: "/opt/shared/claude"');
    });

    test("api-key providers get apiKey baked in and join the right pool", () => {
        const env = newSmithersHome();
        addAccount({ label: "openai-prod", provider: "openai-api", apiKey: "sk-xyz", model: "gpt-5" }, { env });
        addAccount({ label: "anthropic-prod", provider: "anthropic-api", apiKey: "sk-ant" }, { env });
        const generated = generateAgentsTs(env);
        expect(generated).toContain('apiKey: "sk-xyz"');
        expect(generated).toContain('apiKey: "sk-ant"');
        // openai-api goes in the codex pool, anthropic-api in the claude pool
        expect(generated).toMatch(/codex:\s*\[\s*providers\.openaiProd,\s*\]/);
        expect(generated).toMatch(/claude:\s*\[\s*providers\.anthropicProd,\s*\]/);
        // user-specified model wins over the default
        expect(generated).toContain('model: "gpt-5"');
    });

    test("does not serialize both configDir and apiKey for malformed account entries", () => {
        const env = newSmithersHome();
        writeFileSync(join(env.SMITHERS_HOME, "accounts.json"), JSON.stringify({
            version: 1,
            accounts: [
                { label: "claude-mixed", provider: "claude-code", configDir: "/tmp/claude", apiKey: "sk-leak" },
            ],
        }));

        expect(() => generateAgentsTs(env)).toThrow(/configDir.*apiKey|apiKey.*configDir/);
    });

    test("falls back to detection-based output when no accounts are registered", () => {
        const env = newSmithersHome();
        const binDir = createExecutableDir();
        writeFakeClaudeBinary(binDir);
        // No accounts added; reuses existing logic. Detection requires at least
        // one usable agent; we simulate one by setting an API key env var.
        const generated = generateAgentsTs({ ...env, PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter), ANTHROPIC_API_KEY: "sk-ant-test" });
        expect(generated).toContain("// smithers-source: generated");
        // Detection-based output does NOT pull in the accounts.json header.
        expect(generated).not.toContain("~/.smithers/accounts.json");
    });

    test("detection smart pools lead with Claude and skip opencode", () => {
        const env = newSmithersHome();
        const generated = generateAgentsTs(env, {
            preserveProviderIds: ["claude", "codex", "opencode"],
        });

        expect(generated).not.toContain("gpt-5.3-codex");
        expect(generated).toMatch(/smart:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,\s*providers\.codex,/);
        expect(generated).toMatch(/smartTool:\s*\[\s*providers\.claude,\s*providers\.claudeOpus,\s*providers\.codex,/);
        expect(uncommented(generated)).not.toContain("providers.opencode");
        expect(uncommented(generated)).not.toMatch(/smartTool:\s*\[\s*providers\.codex/);
    });

    test("detection smart pools use OpenCode when it is the only preserved CLI provider", () => {
        const env = newSmithersHome();
        const generated = generateAgentsTs(env, {
            preserveProviderIds: ["opencode"],
        });
        const active = uncommented(generated);
        expect(generated).toContain("opencode: OpenCodeAgent");
        expect(active).not.toContain("openrouter: createOpenRouterAgent()");
        expect(active).toMatch(/smart:\s*\[\s*providers\.opencode,/);
        expect(active).toMatch(/smartTool:\s*\[\s*providers\.opencode,/);
        expect(active).toMatch(/review:\s*\[\s*providers\.opencode,/);
    });

    test("preserves generated detection providers when adding accounts in a different shell", () => {
        const env = newSmithersHome();
        const binDir = createExecutableDir();
        writeFakeClaudeBinary(binDir);
        const initial = generateAgentsTs({
            ...env,
            PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
            ANTHROPIC_API_KEY: "sk-ant-test",
        });
        expect(initial).toContain("claude: ClaudeCodeAgent");
        addAccount({ label: "codex-prod", provider: "codex", configDir: `${env.HOME}/.smithers/accounts/codex-prod` }, { env });
        const regenerated = generateAgentsTs(env, {
            preserveProviderIds: extractGeneratedDetectionProviderIds(initial),
        });
        expect(regenerated).toContain("claude: ClaudeCodeAgent");
        expect(regenerated).toContain("claudeOpus: new SmithersClaudeCodeAgent(");
        expect(regenerated).toContain("claudeSonnet: new SmithersClaudeCodeAgent(");
        expect(regenerated).toContain("codexProd: new SmithersCodexAgent(");
    });

    test("preserved OpenRouter default is demoted below a real account added later (never the hot path)", () => {
        const env = newSmithersHome();
        const binDir = createExecutableDir(); // no agent binaries → nothing detected
        // First init on a machine with no agents: the keyless OpenRouter default
        // is the active provider and gets preserved.
        const initial = generateAgentsTs({ ...env, PATH: `${binDir}:/usr/bin:/bin` });
        expect(initial).toContain("openrouter: createOpenRouterAgent()");
        expect([...extractGeneratedDetectionProviderIds(initial)]).toEqual(["openrouter"]);

        // Later the user adds a real subscription account and regenerates
        // (the `smithers agent add` path forwards the preserved ids).
        addAccount(
            { label: "claude-main", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-main` },
            { env },
        );
        const regenerated = generateAgentsTs(
            { ...env, PATH: `${binDir}:/usr/bin:/bin` },
            { preserveProviderIds: extractGeneratedDetectionProviderIds(initial) },
        );

        // In every pool that has both, the real account must precede the keyless
        // OpenRouter default (which throws until OPENROUTER_API_KEY is set), so
        // attempt 1 hits the paid account, not a guaranteed throw.
        for (const pool of ["smart", "smartTool", "cheapFast", "review"]) {
            const match = regenerated.match(new RegExp(`${pool}:\\s*\\[([^\\]]*)\\]`));
            expect(match).toBeTruthy();
            const members = match[1];
            const idxAccount = members.indexOf("providers.claudeMain");
            const idxDefault = members.indexOf("providers.openrouter");
            if (idxAccount >= 0 && idxDefault >= 0) {
                expect(idxDefault).toBeGreaterThan(idxAccount);
            }
        }
    });

    test("does not preserve account labels that collide with generated provider ids", () => {
        const env = newSmithersHome();
        addAccount({ label: "codex", provider: "codex", configDir: `${env.HOME}/.smithers/accounts/codex` }, { env });
        addAccount({ label: "claude-sonnet", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-sonnet` }, { env });

        const generated = generateAgentsTs(env);
        const preserved = extractGeneratedDetectionProviderIds(generated);
        expect([...preserved]).toEqual([]);

        const regenerated = generateAgentsTs(env, { preserveProviderIds: preserved });
        expect(regenerated).toContain("codex: new SmithersCodexAgent(");
        expect(regenerated).toContain("claudeSonnet: new SmithersClaudeCodeAgent(");
        expect(uncommented(regenerated)).not.toContain("codex: CodexAgent");
        expect(uncommented(regenerated)).not.toContain("claude: ClaudeCodeAgent");
    });

    test("preserves generated detection providers during account-driven rewrites", () => {
        const env = newSmithersHome();
        addAccount({ label: "codex-prod", provider: "codex", configDir: `${env.HOME}/.smithers/accounts/codex-prod` }, { env });
        const previous = [
            "// smithers-source: generated",
            "export const providers = {",
            "  claude: ClaudeCodeAgent,",
            "  claudeOpus: new SmithersClaudeCodeAgent({ model: \"claude-opus-4-8\", cwd: process.cwd() }),",
            "  claudeSonnet: new SmithersClaudeCodeAgent({ model: \"claude-sonnet-5\", cwd: process.cwd() }),",
            "} as const;",
            "",
        ].join("\n");
        const generated = generateAgentsTs({ ...env, PATH: "/no-agent-binaries" }, {
            preserveProviderIds: extractGeneratedDetectionProviderIds(previous),
        });
        expect(generated).toContain("claude: ClaudeCodeAgent");
        expect(generated).toContain("claudeOpus: new SmithersClaudeCodeAgent(");
        expect(generated).toContain("claudeSonnet: new SmithersClaudeCodeAgent(");
        expect(generated).toContain("codexProd: new SmithersCodexAgent(");
    });

    test("no detected CLI binaries emits OpenRouter default and comments unavailable providers", () => {
        const env = newSmithersHome();
        const generated = generateAgentsTs({ ...env, PATH: "/no-agent-binaries", OPENROUTER_API_KEY: "" });
        const active = uncommented(generated);
        expect(generated).toContain("import { OpenAIAgent as SmithersOpenAIAgent } from \"smithers-orchestrator\";");
        expect(generated).toContain("openrouter: createOpenRouterAgent()");
        expect(generated).toContain("//   claude: ClaudeCodeAgent,");
        expect(generated).toContain("// import { CodexAgent } from \"./agents/codex\";");
        expect(generated).toContain("// export { CodexAgent } from \"./agents/codex\";");
        expect(active).toContain("smart: [\n    providers.openrouter,");
        expect(active).toContain("smartTool: [\n    providers.openrouter,");
        expect(active).toContain("review: [\n    providers.openrouter,");
        expect(active).not.toContain("providers.claude");
        expect(active).not.toContain("providers.codex");
    });

    test("generated detection id round-trip keeps OpenRouter default and commented providers stable", () => {
        const env = { ...newSmithersHome(), PATH: "/no-agent-binaries", OPENROUTER_API_KEY: "" };
        const initial = generateAgentsTs(env);
        const regenerated = generateAgentsTs(env, {
            preserveProviderIds: extractGeneratedDetectionProviderIds(initial),
        });
        expect([...extractGeneratedDetectionProviderIds(initial)]).toEqual(["openrouter"]);
        expect(regenerated).toBe(initial);
    });
});
