import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutableDir, writeFakeAntigravityBinary, writeFakeClaudeBinary, writeFakeCodexBinary, writeFakeGeminiBinary, writeFakeOpenCodeBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import { ask } from "../src/ask.js";
// We test the exported pure-logic functions by importing the module.
// detectAvailableAgents calls spawnSync so we test the scoring/status logic
// via generateAgentsTs with controlled env.
import { detectAvailableAgents, generateAgentsTs } from "../src/agent-detection.js";
// We can't easily mock spawnSync, but we can test the detection logic
// by verifying structure and scoring behavior with the real environment.
describe("detectAvailableAgents", () => {
    function tempHome() {
        const dir = mkdtempSync(join(tmpdir(), "smithers-detect-home-"));
        onTestFinished(() => {
            rmSync(dir, { recursive: true, force: true });
        });
        return dir;
    }

    function envWithPath(home, binDir, extra = {}) {
        return {
            HOME: home,
            PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            GOOGLE_API_KEY: "",
            GEMINI_API_KEY: "",
            ...extra,
        };
    }

    test("returns array with entries for all known agents", () => {
        const results = detectAvailableAgents({});
        const ids = results.map((r) => r.id);
        expect(ids).toContain("claude");
        expect(ids).toContain("codex");
        expect(ids).toContain("opencode");
        expect(ids).toContain("antigravity");
        expect(ids).toContain("gemini");
        expect(ids).toContain("pi");
        expect(ids).toContain("kimi");
        expect(ids).toContain("amp");
        expect(results.length).toBe(8);
    });
    test("each result has required fields", () => {
        const results = detectAvailableAgents({});
        for (const result of results) {
            expect(typeof result.id).toBe("string");
            expect(typeof result.displayName).toBe("string");
            expect(typeof result.binary).toBe("string");
            expect(typeof result.hasBinary).toBe("boolean");
            expect(typeof result.hasAuthSignal).toBe("boolean");
            expect(typeof result.hasApiKeySignal).toBe("boolean");
            expect(typeof result.hasProjectTrustSignal).toBe("boolean");
            expect(typeof result.status).toBe("string");
            expect(typeof result.score).toBe("number");
            expect(typeof result.usable).toBe("boolean");
            expect(Array.isArray(result.checks)).toBe(true);
            expect(Array.isArray(result.unusableReasons)).toBe(true);
        }
    });
    test("status is 'unavailable' when no binary, no auth, no api key", () => {
        // Empty env, no HOME (so auth signals won't match)
        const results = detectAvailableAgents({ HOME: "/nonexistent-path-xyz" });
        for (const result of results) {
            if (!result.hasBinary && !result.hasAuthSignal && !result.hasApiKeySignal) {
                expect(result.status).toBe("unavailable");
                expect(result.score).toBe(0);
                expect(result.usable).toBe(false);
            }
        }
    });
    test("api key signal detected from env", () => {
        const results = detectAvailableAgents({
            HOME: "/nonexistent-path-xyz",
            ANTHROPIC_API_KEY: "sk-ant-test123",
        });
        const claude = results.find((r) => r.id === "claude");
        expect(claude.hasApiKeySignal).toBe(true);
        // Should be "api-key" if no binary, or higher if binary found
        if (!claude.hasBinary) {
            expect(claude.status).toBe("api-key");
            expect(claude.score).toBe(3);
        }
    });
    test("openai api key detected for codex", () => {
        const emptyPathDir = tempHome();
        const results = detectAvailableAgents({
            HOME: "/nonexistent-path-xyz",
            PATH: emptyPathDir,
            OPENAI_API_KEY: "sk-test123",
        });
        const codex = results.find((r) => r.id === "codex");
        expect(codex.hasApiKeySignal).toBe(true);
        expect(codex.usable).toBe(false);
        expect(codex.unusableReasons.join(" ")).toContain("missing `codex`");
    });
    test("OpenCode detects opencode plus auth.json credentials", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeOpenCodeBinary(binDir);
        mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
        writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), "{}\n");
        const results = detectAvailableAgents(envWithPath(home, binDir));
        const opencode = results.find((r) => r.id === "opencode");
        expect(opencode.hasBinary).toBe(true);
        expect(opencode.hasAuthSignal).toBe(true);
        expect(opencode.usable).toBe(true);
    });
    test("generated agents.ts can use OpenCode with the local scaffold file", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeOpenCodeBinary(binDir);
        mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
        writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), "{}\n");
        const source = generateAgentsTs(envWithPath(home, binDir), {
            cwd: home,
        });
        expect(source).toContain('import { OpenCodeAgent } from "./agents/opencode";');
        expect(source).toContain('export { OpenCodeAgent } from "./agents/opencode";');
        expect(source).toContain("opencode: OpenCodeAgent");
        expect(source).not.toContain("OpenCodeAgent as SmithersOpenCodeAgent");
    });
    test("google api key detected for gemini", () => {
        const results = detectAvailableAgents({
            HOME: "/nonexistent-path-xyz",
            GOOGLE_API_KEY: "test-key",
        });
        const gemini = results.find((r) => r.id === "gemini");
        expect(gemini.hasApiKeySignal).toBe(true);
    });
    test("GEMINI_API_KEY also detected for gemini", () => {
        const results = detectAvailableAgents({
            HOME: "/nonexistent-path-xyz",
            GEMINI_API_KEY: "test-key",
        });
        const gemini = results.find((r) => r.id === "gemini");
        expect(gemini.hasApiKeySignal).toBe(true);
    });
    test("Antigravity detects agy plus antigravity-cli config", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeAntigravityBinary(binDir);
        mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}\n");
        const results = detectAvailableAgents(envWithPath(home, binDir));
        const antigravity = results.find((r) => r.id === "antigravity");
        expect(antigravity.hasBinary).toBe(true);
        expect(antigravity.hasAuthSignal).toBe(true);
        expect(antigravity.usable).toBe(true);
    });
    test("generated agents.ts can use Antigravity without a local scaffold file", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeAntigravityBinary(binDir);
        mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}\n");
        const source = generateAgentsTs(envWithPath(home, binDir), {
            cwd: home,
            scaffoldProviderIds: ["claude", "codex"],
        });
        expect(source).toContain("AntigravityAgent as SmithersAntigravityAgent");
        expect(source).toContain("antigravity: new SmithersAntigravityAgent");
        expect(source).not.toContain("./agents/antigravity");
    });
    test("generated agents.ts preserves an existing legacy Gemini scaffold", () => {
        const source = generateAgentsTs({
            HOME: "/nonexistent-path-xyz",
            PATH: "/usr/bin:/bin",
        }, {
            preserveProviderIds: ["gemini"],
            scaffoldProviderIds: ["gemini"],
        });
        expect(source).toContain('import { GeminiAgent } from "./agents/gemini";');
        expect(source).toContain('export { GeminiAgent } from "./agents/gemini";');
        expect(source).toContain("gemini: GeminiAgent");
        expect(source).not.toContain("gemini: new SmithersGeminiAgent");
    });
    test("checks array includes binary check", () => {
        const results = detectAvailableAgents({});
        for (const result of results) {
            const binaryCheck = result.checks.find((c) => c.startsWith("binary:"));
            expect(binaryCheck).toBeDefined();
        }
    });
    test("checks array includes env checks for agents with api keys", () => {
        const results = detectAvailableAgents({});
        const claude = results.find((r) => r.id === "claude");
        const envCheck = claude.checks.find((c) => c.startsWith("env:ANTHROPIC_API_KEY:"));
        expect(envCheck).toBeDefined();
    });
    test("usable requires both a runnable CLI and credentials", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeClaudeBinary(binDir);
        const results = detectAvailableAgents({
            HOME: home,
            PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
            ANTHROPIC_API_KEY: "sk-ant-test",
        });
        const claude = results.find((r) => r.id === "claude");
        expect(claude.hasBinary).toBe(true);
        expect(claude.hasApiKeySignal).toBe(true);
        expect(claude.usable).toBe(true);
        expect(claude.unusableReasons).toEqual([]);
    });
    test("binary-only agents are not usable", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeCodexBinary(binDir);
        const results = detectAvailableAgents(envWithPath(home, binDir));
        const codex = results.find((r) => r.id === "codex");
        expect(codex.hasBinary).toBe(true);
        expect(codex.hasApiKeySignal).toBe(false);
        expect(codex.usable).toBe(false);
        expect(codex.unusableReasons.join(" ")).toContain("missing credentials");
    });
    test("Gemini requires the current project to be trusted", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeGeminiBinary(binDir);
        mkdirSync(join(home, ".gemini"), { recursive: true });
        writeFileSync(join(home, ".gemini", "oauth_creds.json"), "{}\n");
        const cwd = join(home, "repo");
        mkdirSync(cwd, { recursive: true });
        const untrusted = detectAvailableAgents(envWithPath(home, binDir), { cwd });
        const untrustedGemini = untrusted.find((r) => r.id === "gemini");
        expect(untrustedGemini.hasBinary).toBe(true);
        expect(untrustedGemini.hasAuthSignal).toBe(true);
        expect(untrustedGemini.hasProjectTrustSignal).toBe(false);
        expect(untrustedGemini.usable).toBe(false);
        writeFileSync(join(home, ".gemini", "trustedFolders.json"), JSON.stringify({ [cwd]: "TRUST_FOLDER" }));
        const trusted = detectAvailableAgents(envWithPath(home, binDir), { cwd });
        const trustedGemini = trusted.find((r) => r.id === "gemini");
        expect(trustedGemini.hasProjectTrustSignal).toBe(true);
        expect(trustedGemini.usable).toBe(true);
    });
    test("smithers ask does not auto-select deprecated Gemini", async () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeAntigravityBinary(binDir);
        writeFakeGeminiBinary(binDir);
        const cwd = join(home, "repo");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}\n");
        writeFileSync(join(home, ".gemini", "oauth_creds.json"), "{}\n");
        writeFileSync(join(home, ".gemini", "trustedFolders.json"), JSON.stringify({ [cwd]: "TRUST_FOLDER" }) + "\n");
        const originalEnv = { ...process.env };
        const originalWrite = process.stdout.write;
        let stdout = "";
        Object.assign(process.env, envWithPath(home, binDir));
        process.stdout.write = ((chunk, ...args) => {
            stdout += String(chunk);
            const callback = args.find((arg) => typeof arg === "function");
            if (callback)
                callback();
            return true;
        });
        try {
            await ask(undefined, cwd, { listAgents: true });
        }
        finally {
            process.stdout.write = originalWrite;
            for (const key of Object.keys(process.env))
                delete process.env[key];
            Object.assign(process.env, originalEnv);
        }
        expect(stdout).toContain("* antigravity");
        expect(stdout).not.toContain("* gemini");
    });
    test("kimi detects KIMI_SHARE_DIR as auth signal path", () => {
        const results = detectAvailableAgents({
            HOME: "/nonexistent-path-xyz",
            KIMI_SHARE_DIR: "/tmp/kimi-test",
        });
        const kimi = results.find((r) => r.id === "kimi");
        const authCheck = kimi.checks.find((c) => c.includes("/tmp/kimi-test"));
        expect(authCheck).toBeDefined();
    });
});
