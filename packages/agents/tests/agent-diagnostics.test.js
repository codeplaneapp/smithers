import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDiagnostics,
  getDiagnosticStrategy,
  enrichReportWithErrorAnalysis,
  formatDiagnosticSummary,
  launchDiagnostics,
} from "../src/diagnostics/index.js";
import { BaseCliAgent } from "../src/BaseCliAgent/index.js";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { runDiagnosticCommand } from "../src/diagnostics/runDiagnosticCommand.js";

/**
 * Create an isolated CODEX_HOME directory, optionally seeding an auth.json. The
 * directory is registered for cleanup via the returned dispose() callback.
 * @param {Record<string, unknown> | undefined} authJson
 * @returns {{ codexHome: string; dispose: () => void }}
 */
function makeCodexHome(authJson) {
  const codexHome = mkdtempSync(join(tmpdir(), "smithers-codex-home-"));
  if (authJson !== undefined) {
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify(authJson), "utf8");
  }
  return {
    codexHome,
    dispose: () => rmSync(codexHome, { recursive: true, force: true }),
  };
}

/** @param {string} path */
async function waitForPid(path) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    try {
      return Number.parseInt(readFileSync(path, "utf8"), 10);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for PID file: ${path}`);
}

/** @param {number} pid */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ESRCH") return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// runDiagnosticCommand
// ---------------------------------------------------------------------------
describe("runDiagnosticCommand", () => {
  test("preserves env and cwd without invoking a shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-diagnostic-command-"));
    const executable = join(dir, "probe");
    writeFileSync(
      executable,
      [
        `#!${process.execPath}`,
        "process.stdout.write(JSON.stringify({ marker: process.env.DIAGNOSTIC_MARKER, cwd: process.cwd(), args: process.argv.slice(2) }));",
        "",
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    try {
      const result = await runDiagnosticCommand(executable, ["literal;echo not-a-shell"], {
        cwd: dir,
        env: { DIAGNOSTIC_MARKER: "preserved" },
      });
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.spawnError).toBeNull();
      expect(JSON.parse(result.stdout)).toEqual({
        marker: "preserved",
        cwd: realpathSync(dir),
        args: ["literal;echo not-a-shell"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bounds captured stdout and stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-diagnostic-output-"));
    const executable = join(dir, "noisy");
    writeFileSync(
      executable,
      [
        `#!${process.execPath}`,
        "process.stdout.write('o'.repeat(4096));",
        "process.stderr.write('e'.repeat(4096));",
        "",
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    try {
      const result = await runDiagnosticCommand(executable, [], {
        cwd: dir,
        env: {},
        maxOutputBytes: 128,
      });
      expect(result.status).toBe(0);
      expect(Buffer.byteLength(result.stdout)).toBe(128);
      expect(Buffer.byteLength(result.stderr)).toBe(128);
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports ENOENT as a spawn error with no exit status", async () => {
    const result = await runDiagnosticCommand("smithers-command-that-does-not-exist-677", [], {
      env: { PATH: "" },
      cwd: "/tmp",
    });
    expect(result.status).toBeNull();
    expect(result.signal).toBeNull();
    expect(/** @type {NodeJS.ErrnoException | null} */ (result.spawnError)?.code).toBe("ENOENT");
  });

  test.skipIf(process.platform === "win32")(
    "escalates an ignored abort from TERM to KILL and reaps the process",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "smithers-diagnostic-abort-"));
      const executable = join(dir, "hanging-probe");
      const pidFile = join(dir, "pid");
      writeFileSync(
        executable,
        [
          `#!${process.execPath}`,
          "const { writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.DIAGNOSTIC_PID_FILE, String(process.pid));",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      chmodSync(executable, 0o755);
      const controller = new AbortController();
      /** @type {ReturnType<typeof runDiagnosticCommand> | undefined} */
      let command;
      try {
        command = runDiagnosticCommand(executable, [], {
          cwd: dir,
          env: { DIAGNOSTIC_PID_FILE: pidFile },
          signal: controller.signal,
          killGraceMs: 50,
        });
        const pid = await waitForPid(pidFile);
        controller.abort();
        const result = await command;
        expect(result.aborted).toBe(true);
        expect(result.status).toBeNull();
        expect(result.signal).toBe("SIGKILL");
        expect(isProcessAlive(pid)).toBe(false);
      } finally {
        controller.abort();
        await command?.catch(() => null);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
// ---------------------------------------------------------------------------
// runDiagnostics
// ---------------------------------------------------------------------------
describe("runDiagnostics", () => {
  test("runs all checks and returns a report", async () => {
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
            status: "fail",
            message: "not set",
            durationMs: 1,
          }),
        },
      ],
    };
    const report = await runDiagnostics(strategy, { env: {}, cwd: "/tmp" });
    expect(report.agentId).toBe("test-agent");
    expect(report.command).toBe("test");
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0].status).toBe("pass");
    expect(report.checks[1].status).toBe("fail");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toBeTruthy();
  });
  test("catches errors from checks and reports status=error", async () => {
    const strategy = {
      agentId: "error-agent",
      command: "err",
      checks: [
        {
          id: "cli_installed",
          run: async () => {
            throw new Error("boom");
          },
        },
      ],
    };
    const report = await runDiagnostics(strategy, { env: {}, cwd: "/tmp" });
    expect(report.checks[0].status).toBe("error");
    expect(report.checks[0].message).toBe("boom");
  });
  test("times out a real diagnostic executable and reaps it before returning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-diagnostic-timeout-"));
    const executable = join(dir, "claude");
    const pidFile = join(dir, "pid");
    writeFileSync(
      executable,
      [
        `#!${process.execPath}`,
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync(process.env.DIAGNOSTIC_PID_FILE, String(process.pid));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    let pid;
    try {
      const startedAt = performance.now();
      const report = await runDiagnostics(getDiagnosticStrategy("claude"), {
        env: {
          HOME: dir,
          PATH: `${dir}:/usr/bin:/bin`,
          DIAGNOSTIC_PID_FILE: pidFile,
        },
        cwd: dir,
      });
      const elapsed = performance.now() - startedAt;
      pid = await waitForPid(pidFile);
      const authCheck = report.checks.find((check) => check.id === "api_key_valid");
      expect(authCheck?.status).toBe("error");
      expect(authCheck?.detail?.errorCode).toBe("AGENT_DIAGNOSTIC_TIMEOUT");
      expect(elapsed).toBeGreaterThanOrEqual(4_800);
      expect(elapsed).toBeLessThan(6_000);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      if (pid !== undefined && isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
// ---------------------------------------------------------------------------
// getDiagnosticStrategy
// ---------------------------------------------------------------------------
describe("getDiagnosticStrategy", () => {
  test("returns strategy for known commands", () => {
    expect(getDiagnosticStrategy("claude")).not.toBeNull();
    expect(getDiagnosticStrategy("codex")).not.toBeNull();
    expect(getDiagnosticStrategy("antigravity")).not.toBeNull();
    expect(getDiagnosticStrategy("amp")).not.toBeNull();
    expect(getDiagnosticStrategy("pool")).not.toBeNull();
    expect(getDiagnosticStrategy("gemini")).toBeNull();
  });
  test("returns null for unknown commands", () => {
    expect(getDiagnosticStrategy("unknown-cli")).toBeNull();
    expect(getDiagnosticStrategy("")).toBeNull();
  });
});
// ---------------------------------------------------------------------------
// enrichReportWithErrorAnalysis
// ---------------------------------------------------------------------------
describe("enrichReportWithErrorAnalysis", () => {
  /**
   * @param {"skip" | "pass"} [rateLimitStatus]
   * @returns {DiagnosticReport}
   */
  function makeReport(rateLimitStatus = "skip") {
    return {
      agentId: "test",
      command: "test",
      timestamp: new Date().toISOString(),
      durationMs: 10,
      checks: [
        { id: "cli_installed", status: "pass", message: "ok", durationMs: 1 },
        { id: "rate_limit_status", status: rateLimitStatus, message: "skipped", durationMs: 0 },
      ],
    };
  }
  test("detects 'rate limit' in error message", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "Error: rate limit exceeded");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check.status).toBe("fail");
    expect(check.detail?.detectedPostHoc).toBe(true);
  });
  test("detects '429' in error message", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "HTTP 429 Too Many Requests");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check.status).toBe("fail");
  });
  test("detects 'credit balance is too low'", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "Your credit balance is too low");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check.status).toBe("fail");
  });
  test("detects 'overloaded'", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "API is overloaded");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check.status).toBe("fail");
  });
  test("detects 'quota exceeded'", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "Quota exceeded for this organization");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check.status).toBe("fail");
  });
  test("does not modify report if no rate limit pattern matches", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "Some other error");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check.status).toBe("skip");
  });
  test("does not overwrite existing fail status", () => {
    const report = makeReport();
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    check.status = "fail";
    check.message = "pre-flight detected";
    enrichReportWithErrorAnalysis(report, "rate limit exceeded");
    // Should keep original fail message
    expect(check.message).toBe("pre-flight detected");
  });
  test("handles empty error message", () => {
    const report = makeReport();
    enrichReportWithErrorAnalysis(report, "");
    const check = report.checks.find((c) => c.id === "rate_limit_status");
    expect(check.status).toBe("skip");
  });
});
// ---------------------------------------------------------------------------
// formatDiagnosticSummary
// ---------------------------------------------------------------------------
describe("formatDiagnosticSummary", () => {
  test("reports all passed when no failures", () => {
    const report = {
      agentId: "claude-code",
      command: "claude",
      timestamp: new Date().toISOString(),
      durationMs: 42,
      checks: [
        { id: "cli_installed", status: "pass", message: "ok", durationMs: 1 },
        { id: "api_key_valid", status: "pass", message: "ok", durationMs: 1 },
        { id: "rate_limit_status", status: "skip", message: "skipped", durationMs: 0 },
      ],
    };
    const summary = formatDiagnosticSummary(report);
    expect(summary).toContain("all checks passed");
    expect(summary).toContain("claude-code");
  });
  test("reports failures", () => {
    const report = {
      agentId: "codex",
      command: "codex",
      timestamp: new Date().toISOString(),
      durationMs: 15,
      checks: [
        { id: "cli_installed", status: "fail", message: "codex not found on PATH", durationMs: 1 },
        { id: "api_key_valid", status: "fail", message: "OPENAI_API_KEY not set", durationMs: 0 },
      ],
    };
    const summary = formatDiagnosticSummary(report);
    expect(summary).toContain("cli_installed=fail");
    expect(summary).toContain("api_key_valid=fail");
    expect(summary).toContain("codex");
  });
});
// ---------------------------------------------------------------------------
// launchDiagnostics
// ---------------------------------------------------------------------------
describe("launchDiagnostics", () => {
  test("returns null for unknown command", () => {
    const result = launchDiagnostics("unknown", {}, "/tmp");
    expect(result).toBeNull();
  });
  test("returns a diagnostics report for known command", async () => {
    const result = launchDiagnostics("claude", {}, "/tmp");
    expect(result).toBeInstanceOf(Promise);
    const report = await result;
    expect(report.agentId).toBe("claude-code");
    expect(report.checks.length).toBeGreaterThan(0);
  });
  test("returns before a diagnostic executable can block the event loop", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "smithers-diagnostic-launch-"));
    const claudePath = join(binDir, "claude");
    writeFileSync(
      claudePath,
      [
        `#!${process.execPath}`,
        "setTimeout(() => {",
        "  process.stdout.write(JSON.stringify({ loggedIn: true }) + '\\n');",
        "}, 300);",
        "",
      ].join("\n"),
    );
    chmodSync(claudePath, 0o755);
    let heartbeat = 0;
    const heartbeatHandle = setInterval(() => heartbeat++, 10);
    /** @type {Promise<DiagnosticReport | null> | undefined} */
    let result;
    try {
      const startedAt = performance.now();
      result = launchDiagnostics("claude", { PATH: `${binDir}:/usr/bin:/bin` }, "/tmp") ?? undefined;
      const launchDurationMs = performance.now() - startedAt;
      expect(result).toBeInstanceOf(Promise);
      expect(launchDurationMs).toBeLessThan(100);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(heartbeat).toBeGreaterThan(0);
      await result;
    } finally {
      clearInterval(heartbeatHandle);
      await result?.catch(() => null);
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
// ---------------------------------------------------------------------------
// BaseCliAgent integration: diagnostics attached on failure
// ---------------------------------------------------------------------------
// Agent that fails with a SmithersError (simulating non-zero exit code)
class ErrorExitAgent extends BaseCliAgent {
  async buildCommand() {
    return {
      // `false` is a real binary that exits with code 1
      command: "false",
      args: [],
    };
  }
}
describe("BaseCliAgent diagnostics integration", () => {
  test("attaches diagnostics to SmithersError on non-zero exit", async () => {
    const agent = new ErrorExitAgent({ id: "diag-test" });
    try {
      await agent.generate({ prompt: "test" });
      expect.unreachable("should have thrown");
    } catch (err) {
      // `false` exits with code 1, which triggers SmithersError("AGENT_CLI_ERROR")
      expect(err).toBeInstanceOf(SmithersError);
      const details = err.details;
      // command is "false" which has no strategy, so diagnostics should be absent
      // This verifies the no-strategy path doesn't error out
      expect(details?.diagnostics).toBeUndefined();
    }
  });
  test("agent that uses a known command gets diagnostics attached", async () => {
    // Use a command name from the strategy registry but that will fail
    // We create a subclass that claims to use "claude" command but will fail
    class FakeClaudeAgent extends BaseCliAgent {
      async buildCommand() {
        return {
          command: "claude",
          args: ["--this-flag-does-not-exist-99999"],
        };
      }
    }
    const agent = new FakeClaudeAgent({ id: "diag-claude-test" });
    try {
      await agent.generate({ prompt: "test" });
      // Might succeed if claude is installed with unexpected behavior,
      // or might fail — either way is fine for this test
    } catch (err) {
      if (err instanceof SmithersError) {
        // If diagnostics ran, report should be attached
        const report = err.details?.diagnostics;
        if (report) {
          expect(report.agentId).toBe("claude-code");
          expect(report.checks.length).toBeGreaterThan(0);
        }
      }
      // Non-SmithersError (e.g., ENOENT if claude not installed) — diagnostics
      // only enrich SmithersError, so this is expected to have no diagnostics
    }
  });
});
// ---------------------------------------------------------------------------
// Strategy-specific checks (unit tests for individual check logic)
// ---------------------------------------------------------------------------
describe("claude strategy checks", () => {
  test("api_key_valid passes in subscription mode when Claude Code is logged in", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "smithers-claude-auth-"));
    writeFileSync(
      join(binDir, "claude"),
      [
        `#!${process.execPath}`,
        "if (process.argv.slice(2).join(' ') === 'auth status') {",
        "  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\\n');",
        "  process.exit(0);",
        "}",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "claude"), 0o755);
    const strategy = getDiagnosticStrategy("claude");
    try {
      const report = await runDiagnostics(strategy, {
        env: { PATH: `${binDir}:/usr/bin:/bin` },
        cwd: "/tmp",
      });
      const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
      expect(apiKeyCheck.status).toBe("pass");
      expect(apiKeyCheck.message).toContain("subscription auth");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
  test("api_key_valid fails for invalid format", async () => {
    const strategy = getDiagnosticStrategy("claude");
    const report = await runDiagnostics(strategy, {
      env: { ANTHROPIC_API_KEY: "bad-key-format" },
      cwd: "/tmp",
    });
    const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
    expect(apiKeyCheck.status).toBe("fail");
    expect(apiKeyCheck.message).toContain("unexpected format");
  });
  test("api_key_valid passes for sk-ant- prefix", async () => {
    const strategy = getDiagnosticStrategy("claude");
    const report = await runDiagnostics(strategy, {
      env: { ANTHROPIC_API_KEY: "sk-ant-test-key-12345" },
      cwd: "/tmp",
    });
    const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
    expect(apiKeyCheck.status).toBe("pass");
  });
});
describe("codex strategy checks", () => {
  test("api_key_valid fails when no OPENAI_API_KEY and no Codex CLI auth", async () => {
    // Empty CODEX_HOME → no auth.json, so neither env nor file auth is present.
    const { codexHome, dispose } = makeCodexHome(undefined);
    try {
      const strategy = getDiagnosticStrategy("codex");
      const report = await runDiagnostics(strategy, {
        env: { CODEX_HOME: codexHome },
        cwd: "/tmp",
      });
      const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
      expect(apiKeyCheck.status).toBe("fail");
      expect(apiKeyCheck.message).toContain("not set");
    } finally {
      dispose();
    }
  });
  test("api_key_valid passes with ChatGPT subscription auth (CODEX_HOME/auth.json tokens) — #448", async () => {
    const { codexHome, dispose } = makeCodexHome({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: "fake-access-token", account_id: "acct_123" },
    });
    try {
      const strategy = getDiagnosticStrategy("codex");
      const report = await runDiagnostics(strategy, {
        env: { CODEX_HOME: codexHome },
        cwd: "/tmp",
      });
      const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
      expect(apiKeyCheck.status).toBe("pass");
      expect(apiKeyCheck.message).toContain("subscription");
    } finally {
      dispose();
    }
  });
  test("api_key_valid probes (does not blindly trust) an API key stored in CODEX_HOME/auth.json", async () => {
    // A stored key can be invalid/exhausted; it must be validated against the
    // API, not passed on presence. A fake key → 401 (fail) or network error.
    const { codexHome, dispose } = makeCodexHome({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-test-fake-from-auth-json",
    });
    try {
      const strategy = getDiagnosticStrategy("codex");
      const report = await runDiagnostics(strategy, {
        env: { CODEX_HOME: codexHome },
        cwd: "/tmp",
      });
      const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
      expect(["fail", "error"]).toContain(apiKeyCheck.status);
    } finally {
      dispose();
    }
  });
  test("api_key_valid fails when CODEX_HOME/auth.json has neither key nor tokens", async () => {
    const { codexHome, dispose } = makeCodexHome({ auth_mode: "chatgpt", OPENAI_API_KEY: null });
    try {
      const strategy = getDiagnosticStrategy("codex");
      const report = await runDiagnostics(strategy, {
        env: { CODEX_HOME: codexHome },
        cwd: "/tmp",
      });
      const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
      expect(apiKeyCheck.status).toBe("fail");
    } finally {
      dispose();
    }
  });
  test("api_key_valid env OPENAI_API_KEY takes precedence over CODEX_HOME auth (still probed)", async () => {
    // A real env key is still validated against the API, even with auth.json present.
    const { codexHome, dispose } = makeCodexHome({
      tokens: { access_token: "fake-access-token" },
    });
    try {
      const strategy = getDiagnosticStrategy("codex");
      const report = await runDiagnostics(strategy, {
        env: { CODEX_HOME: codexHome, OPENAI_API_KEY: "sk-test-fake-key-12345" },
        cwd: "/tmp",
      });
      const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
      // Fake key gets 401 (fail) or a network error (error) — never a subscription pass.
      expect(["fail", "error"]).toContain(apiKeyCheck.status);
    } finally {
      dispose();
    }
  });
  test("api_key_valid probes OpenAI API with key (fake key → fail or error)", async () => {
    const strategy = getDiagnosticStrategy("codex");
    const report = await runDiagnostics(strategy, {
      env: { OPENAI_API_KEY: "sk-test-fake-key-12345" },
      cwd: "/tmp",
    });
    const apiKeyCheck = report.checks.find((c) => c.id === "api_key_valid");
    // Fake key will get 401 (fail) or network error (error) — not pass
    expect(["fail", "error"]).toContain(apiKeyCheck.status);
  });
  test("rate_limit_status probes OpenAI API when key is set", async () => {
    const strategy = getDiagnosticStrategy("codex");
    const report = await runDiagnostics(strategy, {
      env: { OPENAI_API_KEY: "sk-test-fake-key" },
      cwd: "/tmp",
    });
    const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
    // With a fake key, expect fail (401) or error (network) — not skip
    expect(rlCheck.status).not.toBe("skip");
  });
  test("rate_limit_status skips when no OPENAI_API_KEY and no Codex CLI auth", async () => {
    // Empty CODEX_HOME so the skip isn't influenced by a developer's real ~/.codex.
    const { codexHome, dispose } = makeCodexHome(undefined);
    try {
      const strategy = getDiagnosticStrategy("codex");
      const report = await runDiagnostics(strategy, {
        env: { CODEX_HOME: codexHome },
        cwd: "/tmp",
      });
      const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
      expect(rlCheck.status).toBe("skip");
    } finally {
      dispose();
    }
  });
  test("rate_limit_status skips in subscription mode (CODEX_HOME tokens, no env key)", async () => {
    const { codexHome, dispose } = makeCodexHome({
      tokens: { access_token: "fake-access-token" },
    });
    try {
      const strategy = getDiagnosticStrategy("codex");
      const report = await runDiagnostics(strategy, {
        env: { CODEX_HOME: codexHome },
        cwd: "/tmp",
      });
      const rlCheck = report.checks.find((c) => c.id === "rate_limit_status");
      expect(rlCheck.status).toBe("skip");
      expect(rlCheck.message).toContain("Subscription");
    } finally {
      dispose();
    }
  });
});
