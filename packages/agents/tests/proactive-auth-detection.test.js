import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KimiAgent } from "../src/index.js";
import { BaseCliAgent } from "../src/BaseCliAgent/index.js";

/**
 * Coverage for commit 1bb532e00 — proactive expired-credential detection
 * (KimiAgent) + auth-pattern classifier (BaseCliAgent.classifyNonRetryableAgentError).
 *
 * Per the source survey done while writing these tests, only KimiAgent has a
 * dedicated proactive credential check. CodexAgent, ClaudeCodeAgent and PiAgent
 * rely on BaseCliAgent's auth-pattern classifier reacting to the CLI's stderr/
 * stdout, so we cover those engines via a synthetic BaseCliAgent that emits
 * the same error text the real CLIs print.
 */

const cleanupDirs = [];
let shareDir = "";

beforeEach(() => {
    shareDir = mkdtempSync(join(tmpdir(), "kimi-share-"));
    cleanupDirs.push(shareDir);
});

afterEach(() => {
    while (cleanupDirs.length) {
        const dir = cleanupDirs.pop();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

describe("KimiAgent proactive credential check (1bb532e00)", () => {
    test("missing credentials directory does NOT throw — let CLI print 'LLM not set'", async () => {
        // Per source: ensureKimiCredentialsUsable returns early if creds dir
        // doesn't exist. The CLI itself will surface 'LLM not set' which the
        // BaseCliAgent classifier then reclassifies as AGENT_CONFIG_INVALID.
        const agent = new KimiAgent({
            env: { KIMI_SHARE_DIR: shareDir },
            model: "kimi-k2-instruct",
        });
        const spec = await agent.buildCommand({ prompt: "x", cwd: process.cwd(), options: {} });
        expect(spec.command).toBe("kimi");
        if (typeof spec.cleanup === "function") await spec.cleanup();
    });

    test("empty credentials directory does NOT throw", async () => {
        mkdirSync(join(shareDir, "credentials"), { recursive: true });
        const agent = new KimiAgent({
            env: { KIMI_SHARE_DIR: shareDir },
            model: "kimi-k2-instruct",
        });
        const spec = await agent.buildCommand({ prompt: "x", cwd: process.cwd(), options: {} });
        expect(spec.command).toBe("kimi");
        if (typeof spec.cleanup === "function") await spec.cleanup();
    });

    test("expired creds with no refresh_token => AGENT_CONFIG_INVALID, failureRetryable=false, no fetch", async () => {
        const credsDir = join(shareDir, "credentials");
        mkdirSync(credsDir, { recursive: true });
        writeFileSync(
            join(credsDir, "default.json"),
            JSON.stringify({
                access_token: "expired",
                expires_at: Math.floor(Date.now() / 1000) - 3600,
                // no refresh_token
            }),
            { mode: 0o600 },
        );
        let fetchCalled = false;
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => {
            fetchCalled = true;
            throw new Error("should not fetch when no refresh_token");
        };
        try {
            const agent = new KimiAgent({
                env: { KIMI_SHARE_DIR: shareDir },
                model: "kimi-k2-instruct",
                id: "kimi-test",
            });
            await agent.buildCommand({ prompt: "x", cwd: process.cwd(), options: {} });
            throw new Error("expected throw");
        } catch (err) {
            expect(err.code).toBe("AGENT_CONFIG_INVALID");
            expect(err.details?.failureRetryable).toBe(false);
            expect(String(err.message)).toContain("Run `kimi login`");
            expect(fetchCalled).toBe(false);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    test("non-OAuth json file (no expires_at) is left alone", async () => {
        const credsDir = join(shareDir, "credentials");
        mkdirSync(credsDir, { recursive: true });
        writeFileSync(
            join(credsDir, "metadata.json"),
            JSON.stringify({ user_id: "abc", created_at: "2026-01-01" }),
            { mode: 0o600 },
        );
        const agent = new KimiAgent({
            env: { KIMI_SHARE_DIR: shareDir },
            model: "kimi-k2-instruct",
        });
        const spec = await agent.buildCommand({ prompt: "x", cwd: process.cwd(), options: {} });
        expect(spec.command).toBe("kimi");
        if (typeof spec.cleanup === "function") await spec.cleanup();
    });

    test("at least one usable credential allows others to remain expired", async () => {
        const credsDir = join(shareDir, "credentials");
        mkdirSync(credsDir, { recursive: true });
        // a.json is fresh — no refresh needed.
        writeFileSync(
            join(credsDir, "a.json"),
            JSON.stringify({
                access_token: "fresh",
                refresh_token: "r",
                expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
            { mode: 0o600 },
        );
        // b.json is expired and has no refresh_token. Per source, the helper
        // tracks `anyUsable` and only throws when nothing was usable.
        writeFileSync(
            join(credsDir, "b.json"),
            JSON.stringify({
                access_token: "expired",
                expires_at: Math.floor(Date.now() / 1000) - 3600,
            }),
            { mode: 0o600 },
        );
        const agent = new KimiAgent({
            env: { KIMI_SHARE_DIR: shareDir },
            model: "kimi-k2-instruct",
        });
        const spec = await agent.buildCommand({ prompt: "x", cwd: process.cwd(), options: {} });
        expect(spec.command).toBe("kimi");
        if (typeof spec.cleanup === "function") await spec.cleanup();
    });
});

/**
 * Synthetic BaseCliAgent test agent that prints a configurable error to
 * stdout/stderr. We use this to verify the classifyNonRetryableAgentError
 * behavior surfaced by the 1bb532e00 commit, which is the path actually used
 * by Codex / Claude / Pi when their CLIs report auth failures.
 */
class FakeCliAgent extends BaseCliAgent {
    /** @param {{ command: string, args: string[], stdoutErrorPatterns?: RegExp[] }} spec */
    constructor(spec, agentOpts = {}) {
        super({ id: spec.id ?? "fake-cli", ...agentOpts });
        this._spec = spec;
    }
    async buildCommand() {
        return this._spec;
    }
}

let fakeBinDir = "";

beforeEach(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), "fake-cli-"));
    cleanupDirs.push(fakeBinDir);
});

/**
 * Make a fake CLI binary that prints `text` to stdout/stderr with the given
 * exit code, then exits.
 * @param {{ name?: string, stderr?: string, stdout?: string, exitCode?: number }} cfg
 */
function makeFakeCli(cfg) {
    const binPath = join(fakeBinDir, cfg.name ?? "fake");
    const lines = [
        "#!/usr/bin/env node",
        cfg.stdout ? `process.stdout.write(${JSON.stringify(cfg.stdout)});` : "",
        cfg.stderr ? `process.stderr.write(${JSON.stringify(cfg.stderr)});` : "",
        `process.exit(${cfg.exitCode ?? 0});`,
    ].filter(Boolean).join("\n");
    writeFileSync(binPath, lines + "\n", { mode: 0o755 });
    chmodSync(binPath, 0o755);
    return binPath;
}

describe("BaseCliAgent.classifyNonRetryableAgentError — auth patterns (covers Codex/Claude/Pi via stderr)", () => {
    /** Runs the agent and returns the rejection. */
    async function runExpectingFailure(agent) {
        try {
            await agent.generate({ prompt: "test" });
            throw new Error("expected agent.generate to throw");
        } catch (err) {
            return err;
        }
    }

    test("'Error code: 401 invalid_authentication' on stderr => AGENT_CONFIG_INVALID", async () => {
        const bin = makeFakeCli({
            stderr: "Error code: 401 invalid_authentication\n",
            exitCode: 1,
        });
        const agent = new FakeCliAgent({ command: bin, args: [] });
        const err = await runExpectingFailure(agent);
        expect(err.code).toBe("AGENT_CONFIG_INVALID");
        expect(err.details?.failureRetryable).toBe(false);
        expect(String(err.message)).toContain("re-authenticate");
    });

    test("'API Key … may have expired' on stderr => AGENT_CONFIG_INVALID", async () => {
        const bin = makeFakeCli({
            stderr: "API Key abcdef may have expired or is invalid\n",
            exitCode: 1,
        });
        const agent = new FakeCliAgent({ command: bin, args: [] });
        const err = await runExpectingFailure(agent);
        expect(err.code).toBe("AGENT_CONFIG_INVALID");
        expect(err.details?.failureRetryable).toBe(false);
    });

    test("'auth token expired' on stderr => AGENT_CONFIG_INVALID", async () => {
        const bin = makeFakeCli({
            stderr: "auth token expired, please re-authenticate\n",
            exitCode: 1,
        });
        const agent = new FakeCliAgent({ command: bin, args: [] });
        const err = await runExpectingFailure(agent);
        expect(err.code).toBe("AGENT_CONFIG_INVALID");
        expect(err.details?.failureRetryable).toBe(false);
    });

    test("'invalid_authentication_error' on stderr => AGENT_CONFIG_INVALID", async () => {
        const bin = makeFakeCli({
            stderr: "downstream: invalid_authentication_error: bad cred\n",
            exitCode: 1,
        });
        const agent = new FakeCliAgent({ command: bin, args: [] });
        const err = await runExpectingFailure(agent);
        expect(err.code).toBe("AGENT_CONFIG_INVALID");
    });

    test("LLM not set => AGENT_CONFIG_INVALID (covers stdoutErrorPatterns surface)", async () => {
        const bin = makeFakeCli({
            stdout: "LLM not set\n",
            exitCode: 0,
        });
        const agent = new FakeCliAgent({
            command: bin,
            args: [],
            stdoutErrorPatterns: [/^LLM not set/i],
        });
        const err = await runExpectingFailure(agent);
        expect(err.code).toBe("AGENT_CONFIG_INVALID");
        expect(err.details?.failureRetryable).toBe(false);
    });

    test("kimi 401 stdout pattern => AGENT_CONFIG_INVALID (belt-and-suspenders)", async () => {
        // Kimi explicitly adds three additional stdout error patterns for the
        // 401 surface so that runs not seeing stderr still reach the
        // non-retryable path. We verify that a synthetic agent using kimi's
        // stdoutErrorPatterns reclassifies these.
        const kimiPatterns = [
            /^LLM not set/i,
            /^LLM not supported/i,
            /^Max steps reached/i,
            /^Interrupted by user$/i,
            /^Unknown error:/i,
            /^Error:/i,
            /Error code:\s*401\b[^\n]*/i,
            /\binvalid_authentication_error\b/i,
            /API\s*Key\s+appears to be invalid or may have expired/i,
        ];
        const bin = makeFakeCli({
            stdout: "Error code: 401 - The API key is invalid or has expired\n",
            exitCode: 0,
        });
        const agent = new FakeCliAgent({
            command: bin,
            args: [],
            stdoutErrorPatterns: kimiPatterns,
        });
        const err = await runExpectingFailure(agent);
        expect(err.code).toBe("AGENT_CONFIG_INVALID");
        expect(err.details?.failureRetryable).toBe(false);
    });

    test("multiple auth errors interleaved with valid runs are each classified independently", async () => {
        const authBin = makeFakeCli({
            name: "fake-auth",
            stderr: "Error code: 401 invalid_authentication\n",
            exitCode: 1,
        });
        const okBin = makeFakeCli({
            name: "fake-ok",
            stdout: "all good\n",
            exitCode: 0,
        });

        const authAgent = new FakeCliAgent({ command: authBin, args: [] });
        const okAgent = new FakeCliAgent({ command: okBin, args: [] });

        const err1 = await runExpectingFailure(authAgent);
        const ok1 = await okAgent.generate({ prompt: "ok" });
        const err2 = await runExpectingFailure(authAgent);
        const ok2 = await okAgent.generate({ prompt: "ok2" });

        expect(err1.code).toBe("AGENT_CONFIG_INVALID");
        expect(err2.code).toBe("AGENT_CONFIG_INVALID");
        expect(ok1.text).toContain("all good");
        expect(ok2.text).toContain("all good");
    });

    test("non-auth CLI errors are NOT reclassified — engine retains retryability", async () => {
        const bin = makeFakeCli({
            stderr: "ECONNRESET: temporary network blip\n",
            exitCode: 1,
        });
        const agent = new FakeCliAgent({ command: bin, args: [] });
        const err = await runExpectingFailure(agent);
        // Should be the generic AGENT_CLI_ERROR, NOT AGENT_CONFIG_INVALID.
        expect(err.code).toBe("AGENT_CLI_ERROR");
        // No failureRetryable flag => engine treats as retryable.
        expect(err.details?.failureRetryable).toBeUndefined();
    });
});
