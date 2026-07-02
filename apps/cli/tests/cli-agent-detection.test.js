import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createExecutableDir, writeExecutable, writeFakeAntigravityBinary, writeFakeClaudeBinary, writeFakeCodexBinary, writeFakeOpenClawBinary, writeFakeOpenCodeBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
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
            PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            GOOGLE_API_KEY: "",
            GEMINI_API_KEY: "",
            ...extra,
        };
    }

    function uncommented(source) {
        return source
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("//"))
            .join("\n");
    }

    function writeLoggedOutClaudeBinary(binDir) {
        writeExecutable(binDir, "claude", [
            `#!${process.execPath}`,
            "if (process.argv.slice(2).join(' ') === 'auth status') {",
            "  process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: null }) + '\\n');",
            "  process.exit(1);",
            "}",
            "process.stdout.write('ok\\n');",
            "",
        ].join("\n"));
    }

    test("returns array with entries for all known agents", () => {
        const results = detectAvailableAgents({});
        const ids = results.map((r) => r.id);
        expect(ids).toContain("claude");
        expect(ids).toContain("codex");
        expect(ids).toContain("openrouter");
        expect(ids).toContain("opencode");
        expect(ids).toContain("antigravity");
        expect(ids).toContain("pi");
        expect(ids).toContain("kimi");
        expect(ids).toContain("amp");
        expect(ids).toContain("vibe");
        expect(ids).toContain("hermes");
        expect(ids).toContain("openclaw");
        expect(results.length).toBe(11);
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
    test("Claude API key env alone is not a default Claude Code harness signal", () => {
        const results = detectAvailableAgents({
            HOME: "/nonexistent-path-xyz",
            ANTHROPIC_API_KEY: "sk-ant-test123",
        });
        const claude = results.find((r) => r.id === "claude");
        expect(claude.hasApiKeySignal).toBe(false);
        expect(claude.usable).toBe(false);
        expect(claude.unusableReasons.join(" ")).toContain("missing credentials");
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
    test("openrouter api key is detected without a CLI binary", () => {
        const emptyPathDir = tempHome();
        const results = detectAvailableAgents({
            HOME: "/nonexistent-path-xyz",
            PATH: emptyPathDir,
            OPENROUTER_API_KEY: "sk-or-test",
        });
        const openrouter = results.find((r) => r.id === "openrouter");
        expect(openrouter.hasBinary).toBe(false);
        expect(openrouter.hasApiKeySignal).toBe(true);
        expect(openrouter.usable).toBe(true);
        expect(openrouter.checks).toContain("binary:openrouter-api:not-required");
    });
    test("OpenCode detects opencode plus auth.json credentials", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeOpenCodeBinary(binDir);
        mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
        writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ anthropic: { accessToken: "test" } }) + "\n");
        const results = detectAvailableAgents(envWithPath(home, binDir));
        const opencode = results.find((r) => r.id === "opencode");
        expect(opencode.hasBinary).toBe(true);
        expect(opencode.hasAuthSignal).toBe(true);
        expect(opencode.usable).toBe(true);
    });
    test("OpenClaw detects openclaw plus openclaw.json runtime config", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeOpenClawBinary(binDir);
        mkdirSync(join(home, ".openclaw"), { recursive: true });
        writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { default: "main" } }) + "\n");
        const results = detectAvailableAgents(envWithPath(home, binDir));
        const openclaw = results.find((r) => r.id === "openclaw");
        expect(openclaw.hasBinary).toBe(true);
        expect(openclaw.hasAuthSignal).toBe(true);
        expect(openclaw.usable).toBe(true);
    });
    test("generated agents.ts uses OpenCode for OpenCode-only defaults", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeOpenCodeBinary(binDir);
        mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
        writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ anthropic: { accessToken: "test" } }) + "\n");
        const source = generateAgentsTs(envWithPath(home, binDir), {
            cwd: home,
        });
        const active = uncommented(source);
        expect(active).toContain("opencode: OpenCodeAgent");
        expect(active).toContain("cheapFast: [\n    providers.opencode,");
        expect(active).toContain("smart: [\n    providers.opencode,");
        expect(active).toContain("smartTool: [\n    providers.opencode,");
        expect(active).not.toContain("openrouter: createOpenRouterAgent()");
    });
    test("generated agents.ts can use OpenClaw as a workflow agent without local scaffolding", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeOpenClawBinary(binDir);
        mkdirSync(join(home, ".openclaw"), { recursive: true });
        writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { default: "main" } }) + "\n");
        const source = generateAgentsTs(envWithPath(home, binDir), {
            cwd: home,
            scaffoldProviderIds: ["claude", "codex"],
        });
        expect(source).toContain("OpenClawAgent as SmithersOpenClawAgent");
        expect(source).toContain("openclaw: new SmithersOpenClawAgent");
        expect(source).toContain("cheapFast: [\n    providers.openclaw,");
        expect(source).toContain("smart: [\n    providers.openclaw,");
        expect(source).toContain("smartTool: [\n    providers.openclaw,");
        expect(source).not.toContain("./agents/openclaw");
    });
    test("Antigravity detects agy plus antigravity-cli config", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeAntigravityBinary(binDir);
        mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ signedIn: true }) + "\n");
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
        writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ signedIn: true }) + "\n");
        const source = generateAgentsTs(envWithPath(home, binDir), {
            cwd: home,
            scaffoldProviderIds: ["claude", "codex"],
        });
        expect(source).toContain("AntigravityAgent as SmithersAntigravityAgent");
        expect(source).toContain("antigravity: new SmithersAntigravityAgent");
        expect(source).not.toContain("./agents/antigravity");
    });
    test("checks array includes binary check", () => {
        const results = detectAvailableAgents({});
        for (const result of results) {
            const binaryCheck = result.checks.find((c) => c.startsWith("binary:"));
            expect(binaryCheck).toBeDefined();
        }
    });
    test("binary detection does not hardcode /bin/bash", () => {
        const source = readFileSync(new URL("../src/agent-detection.js", import.meta.url), "utf8");
        expect(source).not.toContain("/bin/bash");
    });
    test("checks array includes env checks for agents with api keys", () => {
        const results = detectAvailableAgents({});
        const codex = results.find((r) => r.id === "codex");
        const envCheck = codex.checks.find((c) => c.startsWith("env:OPENAI_API_KEY:"));
        expect(envCheck).toBeDefined();
    });
    test("usable requires both a runnable CLI and credentials", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeClaudeBinary(binDir);
        mkdirSync(join(home, ".claude"), { recursive: true });
        writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
            claudeAiOauth: { accessToken: "test", expiresAt: Date.now() + 60_000 },
        }) + "\n");
        const results = detectAvailableAgents({
            HOME: home,
            PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
        });
        const claude = results.find((r) => r.id === "claude");
        expect(claude.hasBinary).toBe(true);
        expect(claude.hasAuthSignal).toBe(true);
        expect(claude.usable).toBe(true);
        expect(claude.unusableReasons).toEqual([]);
    });
    test("Claude stale credential files are not usable when auth status is logged out", () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeLoggedOutClaudeBinary(binDir);
        mkdirSync(join(home, ".claude"), { recursive: true });
        writeFileSync(join(home, ".claude", ".credentials.json"), "{}\n");
        const results = detectAvailableAgents(envWithPath(home, binDir));
        const claude = results.find((r) => r.id === "claude");
        expect(claude.hasBinary).toBe(true);
        expect(claude.hasAuthSignal).toBe(true);
        expect(claude.usable).toBe(false);
        expect(claude.unusableReasons.join(" ")).toContain("not logged in");
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
    test("smithers ask does not list Gemini CLI even if old gemini files exist", async () => {
        const home = tempHome();
        const binDir = createExecutableDir();
        writeFakeAntigravityBinary(binDir);
        const cwd = join(home, "repo");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
        writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ signedIn: true }) + "\n");
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
        const authCheck = kimi.checks.find((c) => c.replaceAll("\\", "/").includes("/tmp/kimi-test"));
        expect(authCheck).toBeDefined();
    });
});
