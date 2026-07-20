import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiagnosticStrategy, enrichReportWithErrorAnalysis, formatDiagnosticSummary, runDiagnostics, } from "../src/diagnostics/index.js";
// ---------------------------------------------------------------------------
// getDiagnosticStrategy — strategy registry lookup
// ---------------------------------------------------------------------------
describe("getDiagnosticStrategy", () => {
    test("returns claude strategy for 'claude'", () => {
        const strategy = getDiagnosticStrategy("claude");
        expect(strategy).not.toBeNull();
        expect(strategy.agentId).toBe("claude-code");
        expect(strategy.command).toBe("claude");
        expect(strategy.checks.length).toBeGreaterThanOrEqual(3);
    });
    test("returns codex strategy for 'codex'", () => {
        const strategy = getDiagnosticStrategy("codex");
        expect(strategy).not.toBeNull();
        expect(strategy.agentId).toBe("codex");
    });
    test("returns antigravity strategy for 'antigravity'", () => {
        const strategy = getDiagnosticStrategy("antigravity");
        expect(strategy).not.toBeNull();
        expect(strategy.agentId).toBe("antigravity");
        expect(strategy.command).toBe("agy");
    });
    test("does not expose a Gemini CLI diagnostics strategy", () => {
        expect(getDiagnosticStrategy("gemini")).toBeNull();
    });
    test("returns pi strategy for 'pi'", () => {
        const strategy = getDiagnosticStrategy("pi");
        expect(strategy).not.toBeNull();
        expect(strategy.agentId).toBe("pi");
    });
    test("returns amp strategy for 'amp'", () => {
        const strategy = getDiagnosticStrategy("amp");
        expect(strategy).not.toBeNull();
        expect(strategy.agentId).toBe("amp");
    });
    test("returns null for unknown command", () => {
        expect(getDiagnosticStrategy("unknown-agent")).toBeNull();
        expect(getDiagnosticStrategy("")).toBeNull();
    });
});
// ---------------------------------------------------------------------------
// enrichReportWithErrorAnalysis — post-hoc rate limit detection
// ---------------------------------------------------------------------------
describe("enrichReportWithErrorAnalysis", () => {
    /**
   * @param {"pass" | "fail" | "skip" | "error"} [rateLimitStatus]
   * @returns {DiagnosticReport}
   */
    function makeReport(rateLimitStatus = "pass") {
        return {
            agentId: "test",
            command: "test",
            timestamp: new Date().toISOString(),
            durationMs: 10,
            checks: [
                { id: "cli_installed", status: "pass", message: "ok", durationMs: 1 },
                { id: "api_key_valid", status: "pass", message: "ok", durationMs: 1 },
                {
                    id: "rate_limit_status",
                    status: rateLimitStatus,
                    message: "Rate limit OK",
                    durationMs: 1,
                },
            ],
        };
    }
    test("detects rate limit pattern in error message", () => {
        const report = makeReport("pass");
        enrichReportWithErrorAnalysis(report, "Error: rate limit exceeded");
        const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
        expect(rlCheck.status).toBe("fail");
        expect(rlCheck.detail?.detectedPostHoc).toBe(true);
    });
    test("detects 429 in error message", () => {
        const report = makeReport("skip");
        enrichReportWithErrorAnalysis(report, "HTTP 429 Too Many Requests");
        const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
        expect(rlCheck.status).toBe("fail");
    });
    test("detects quota exceeded pattern", () => {
        const report = makeReport("pass");
        enrichReportWithErrorAnalysis(report, "quota exceeded for this model");
        const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
        expect(rlCheck.status).toBe("fail");
    });
    test("detects credit balance too low", () => {
        const report = makeReport("pass");
        enrichReportWithErrorAnalysis(report, "credit balance is too low to continue");
        const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
        expect(rlCheck.status).toBe("fail");
    });
    test("does not overwrite already-failed rate limit check", () => {
        const report = makeReport("fail");
        const originalMsg = report.checks.find((c) => c.id === "rate_limit_status").message;
        enrichReportWithErrorAnalysis(report, "rate limit exceeded");
        const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
        // Should remain as the original failure, not overwritten
        expect(rlCheck.message).toBe(originalMsg);
    });
    test("no-ops on empty error message", () => {
        const report = makeReport("pass");
        enrichReportWithErrorAnalysis(report, "");
        const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
        expect(rlCheck.status).toBe("pass");
    });
    test("no-ops when error does not match any pattern", () => {
        const report = makeReport("pass");
        enrichReportWithErrorAnalysis(report, "connection refused");
        const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
        expect(rlCheck.status).toBe("pass");
    });
});
// ---------------------------------------------------------------------------
// formatDiagnosticSummary — human-readable summary
// ---------------------------------------------------------------------------
describe("formatDiagnosticSummary", () => {
    test("reports all checks passed when no failures", () => {
        const report = {
            agentId: "claude-code",
            command: "claude",
            timestamp: new Date().toISOString(),
            durationMs: 42,
            checks: [
                { id: "cli_installed", status: "pass", message: "found", durationMs: 1 },
                { id: "api_key_valid", status: "pass", message: "valid", durationMs: 1 },
                { id: "rate_limit_status", status: "skip", message: "skip", durationMs: 0 },
            ],
        };
        const summary = formatDiagnosticSummary(report);
        expect(summary).toContain("claude-code");
        expect(summary).toContain("all checks passed");
        expect(summary).toContain("42ms");
    });
    test("reports failures and errors in summary", () => {
        const report = {
            agentId: "codex",
            command: "codex",
            timestamp: new Date().toISOString(),
            durationMs: 100,
            checks: [
                { id: "cli_installed", status: "fail", message: "not found", durationMs: 1 },
                { id: "api_key_valid", status: "error", message: "probe crashed", durationMs: 5 },
                { id: "rate_limit_status", status: "pass", message: "ok", durationMs: 1 },
            ],
        };
        const summary = formatDiagnosticSummary(report);
        expect(summary).toContain("codex");
        expect(summary).toContain("cli_installed=fail");
        expect(summary).toContain("api_key_valid=error");
        expect(summary).toContain("100ms");
    });
});
// ---------------------------------------------------------------------------
// runDiagnostics — runner with per-check timeout
// ---------------------------------------------------------------------------
describe("runDiagnostics", () => {
    test("runs all checks and returns report", async () => {
        const strategy = {
            agentId: "test-agent",
            command: "test",
            checks: [
                {
                    id: "cli_installed",
                    run: async () => ({
                        id: "cli_installed",
                        status: "pass",
                        message: "found",
                        durationMs: 1,
                    }),
                },
                {
                    id: "api_key_valid",
                    run: async () => ({
                        id: "api_key_valid",
                        status: "pass",
                        message: "valid",
                        durationMs: 2,
                    }),
                },
            ],
        };
        const report = await runDiagnostics(strategy, {
            env: {},
            cwd: "/tmp",
        });
        expect(report.agentId).toBe("test-agent");
        expect(report.command).toBe("test");
        expect(report.checks).toHaveLength(2);
        expect(report.checks[0].status).toBe("pass");
        expect(report.checks[1].status).toBe("pass");
        expect(report.durationMs).toBeGreaterThan(0);
        expect(report.timestamp).toBeTruthy();
    });
    test("handles check that throws an error", async () => {
        const strategy = {
            agentId: "failing-agent",
            command: "fail",
            checks: [
                {
                    id: "cli_installed",
                    run: async () => {
                        throw new Error("BOOM");
                    },
                },
            ],
        };
        const report = await runDiagnostics(strategy, {
            env: {},
            cwd: "/tmp",
        });
        expect(report.checks).toHaveLength(1);
        expect(report.checks[0].status).toBe("error");
        expect(report.checks[0].message).toContain("BOOM");
    });

    test("Claude subscription diagnostics fail when auth status reports logged out", async () => {
        const binDir = mkdtempSync(join(tmpdir(), "smithers-claude-auth-"));
        const home = mkdtempSync(join(tmpdir(), "smithers-claude-home-"));
        try {
            const claudeBin = join(binDir, "claude");
            writeFileSync(claudeBin, [
                `#!${process.execPath}`,
                "if (process.argv.slice(2).join(' ') === 'auth status') {",
                "  process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: null }) + '\\n');",
                "  process.exit(1);",
                "}",
                "process.stdout.write('ok\\n');",
                "",
            ].join("\n"));
            chmodSync(claudeBin, 0o755);

            const report = await runDiagnostics(getDiagnosticStrategy("claude"), {
                env: { HOME: home, PATH: `${binDir}:/usr/bin:/bin` },
                cwd: home,
            });

            const authCheck = report.checks.find((check) => check.id === "api_key_valid");
            expect(authCheck?.status).toBe("fail");
            expect(authCheck?.message).toContain("not logged in");
        }
        finally {
            rmSync(binDir, { recursive: true, force: true });
            rmSync(home, { recursive: true, force: true });
        }
    });

    test("Claude subscription diagnostics pass from ~/.claude/.credentials.json without an API key", async () => {
        // Common Linux/CI Claude Code subscription path: no ANTHROPIC_API_KEY,
        // no `claude` on PATH, credentials live on disk.
        const home = mkdtempSync(join(tmpdir(), "smithers-claude-cred-"));
        try {
            mkdirSync(join(home, ".claude"), { recursive: true });
            writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
                claudeAiOauth: {
                    accessToken: "sk-ant-oat-fixture-token",
                    expiresAt: Date.now() + 3_600_000,
                },
            }) + "\n");

            const report = await runDiagnostics(getDiagnosticStrategy("claude"), {
                env: { HOME: home, PATH: "/usr/bin:/bin" },
                cwd: home,
            });

            const authCheck = report.checks.find((check) => check.id === "api_key_valid");
            expect(authCheck?.status).toBe("pass");
            expect(authCheck?.message).toContain("OAuth credentials are present");
        }
        finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test.skipIf(process.platform !== "darwin")("Claude subscription diagnostics pass from the macOS Keychain when no credentials file exists", async () => {
        const binDir = mkdtempSync(join(tmpdir(), "smithers-claude-keychain-bin-"));
        const home = mkdtempSync(join(tmpdir(), "smithers-claude-keychain-home-"));
        try {
            // Fake `security` prints Keychain-stored OAuth credentials; reached
            // only because no ~/.claude/.credentials.json exists on disk.
            const securityBin = join(binDir, "security");
            writeFileSync(securityBin, [
                `#!${process.execPath}`,
                "process.stdout.write(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-keychain-token', expiresAt: " + (Date.now() + 3_600_000) + " } }));",
                "process.exit(0);",
                "",
            ].join("\n"));
            chmodSync(securityBin, 0o755);

            const report = await runDiagnostics(getDiagnosticStrategy("claude"), {
                env: { HOME: home, PATH: `${binDir}:/usr/bin:/bin` },
                cwd: home,
            });

            const authCheck = report.checks.find((check) => check.id === "api_key_valid");
            expect(authCheck?.status).toBe("pass");
            expect(authCheck?.message).toContain("OAuth credentials are present");
        }
        finally {
            rmSync(binDir, { recursive: true, force: true });
            rmSync(home, { recursive: true, force: true });
        }
    });
});
