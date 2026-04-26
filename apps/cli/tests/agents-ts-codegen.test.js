import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addAccount } from "@smithers-orchestrator/accounts";
import { generateAgentsTs } from "../src/agent-detection.js";

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
        expect(generated).toContain("claude: [providers.claudeWork, providers.claudePersonal]");
        expect(generated).toContain("codex: [providers.codexWork]");
        // smart pool combines all
        expect(generated).toContain("smart: [providers.claudeWork, providers.claudePersonal, providers.codexWork]");
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
        expect(generated).toContain("codex: [providers.openaiProd]");
        expect(generated).toContain("claude: [providers.anthropicProd]");
        // user-specified model wins over the default
        expect(generated).toContain('model: "gpt-5"');
    });

    test("falls back to detection-based output when no accounts are registered", () => {
        const env = newSmithersHome();
        // No accounts added; reuses existing logic. Detection requires at least
        // one usable agent; we simulate one by setting an API key env var.
        const generated = generateAgentsTs({ ...env, ANTHROPIC_API_KEY: "test" });
        expect(generated).toContain("// smithers-source: generated");
        // Detection-based output does NOT pull in the accounts.json header.
        expect(generated).not.toContain("~/.smithers/accounts.json");
    });
});
