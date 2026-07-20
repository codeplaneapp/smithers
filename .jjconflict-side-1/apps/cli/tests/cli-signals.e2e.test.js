// CLI signal-handling end-to-end tests.
//
// These spawn the CLI as a real subprocess (Bun.spawn) so we exercise
// the production process.on(SIGINT/SIGTERM) wiring in apps/cli/src/index.js
// rather than the in-process abort path.
//
// Each test:
//   1. starts a workflow that writes a row to sqlite, then sleeps
//   2. waits for the row to appear (proves the run is in flight)
//   3. delivers a signal
//   4. waits for the child to exit
//   5. asserts the run row was durably marked `cancelled` with its heartbeat
//      cleared (graceful shutdown ran — the regression guard for the bug where
//      a process.exit() signal handler pre-empted the cancelled-status write and
//      left the run stuck "running" until its heartbeat went stale)
//   6. re-opens the sqlite db and asserts it is still readable
//      (no `.db-wal` corruption after a clean signal-driven shutdown)
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTempRepo } from "../../../packages/smithers/tests/e2e-helpers.js";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.js");

// `createTempRepo` symlinks runtime deps from `${REPO_ROOT}/node_modules`.
// In a git worktree those are not always materialized. If they're missing,
// any spawned bun run would fail with ENOENT before SIGINT is even
// deliverable, which would mask real signal regressions. So skip the e2e
// pieces entirely in that case.
const E2E_DEPS_AVAILABLE = existsSync(join(REPO_ROOT, "node_modules", "zod")) &&
    existsSync(join(REPO_ROOT, "node_modules", "react"));
const testIfDeps = E2E_DEPS_AVAILABLE ? test : test.skip;

/**
 * Workflow that writes a sentinel row and then sleeps in a compute task.
 * The sentinel lets us know the run actually started.
 *
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function writeSlowWorkflow(repo) {
    return repo.write("workflow.tsx", [
        '/** @jsxImportSource smithers-orchestrator */',
        'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
        'import { z } from "zod";',
        '',
        'const { smithers, outputs } = createSmithers({',
        '  sentinel: z.object({ value: z.number() }),',
        '});',
        '',
        'export default smithers(() => (',
        '  <Workflow name="slow">',
        '    <Task id="mark" output={outputs.sentinel}>',
        '      {{ value: 1 }}',
        '    </Task>',
        '    <Task id="sleeper" output={outputs.sentinel} dependsOn={["mark"]}>',
        '      {async () => {',
        '        await new Promise((r) => setTimeout(r, 30_000));',
        '        return { value: 2 };',
        '      }}',
        '    </Task>',
        '  </Workflow>',
        '));',
        '',
    ].join("\n"));
}

/**
 * @param {string} dbPath
 * @param {string} runId
 */
async function waitForSentinel(dbPath, runId, timeoutMs = 25_000) {
    const start = Date.now();
    let lastErr;
    while (Date.now() - start < timeoutMs) {
        if (existsSync(dbPath)) {
            try {
                const db = new Database(dbPath, { readonly: true });
                try {
                    const row = db.query(
                        "SELECT 1 FROM _smithers_nodes WHERE run_id = ?",
                    ).get(runId);
                    if (row) return true;
                    // Also accept any row in the runs table to confirm setup;
                    // then fall through to next poll.
                } catch (err) {
                    lastErr = err;
                } finally {
                    db.close();
                }
            } catch (err) {
                lastErr = err;
            }
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}

/**
 * Poll the runs table until the run reaches the expected status (graceful
 * shutdown writes it during signal handling, so it may lag the process exit).
 *
 * @param {string} dbPath
 * @param {string} runId
 * @param {string} status
 * @returns {Promise<{ status: string, heartbeat: number | null } | null>}
 */
async function waitForRunStatus(dbPath, runId, status, timeoutMs = 10_000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        if (existsSync(dbPath)) {
            try {
                const db = new Database(dbPath, { readonly: true });
                try {
                    const row = db.query(
                        "SELECT status, heartbeat_at_ms AS heartbeat FROM _smithers_runs WHERE run_id = ?",
                    ).get(runId);
                    if (row) {
                        last = { status: row.status, heartbeat: row.heartbeat ?? null };
                        if (row.status === status) return last;
                    }
                } catch { } finally {
                    db.close();
                }
            } catch { }
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    return last;
}

/**
 * @param {"SIGINT" | "SIGTERM"} sig
 */
async function runSignalScenario(sig) {
    const repo = createTempRepo();
    writeSlowWorkflow(repo);
    const runId = `${sig.toLowerCase()}-${Date.now()}`;
    // The default dbPath in createSmithers() is "./smithers.db" relative to
    // cwd, which is the temp repo directory.
    const dbPath = join(repo.dir, "smithers.db");
    const proc = Bun.spawn({
        cmd: [process.execPath, "run", CLI_ENTRY, "up", "workflow.tsx", "--run-id", runId, "--no-log"],
        cwd: repo.dir,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
    });
    const stderrPromise = new Response(proc.stderr).text();
    const stdoutPromise = new Response(proc.stdout).text();
    try {
        // Locate the actual db file the CLI created. The default dbPath in
        // createSmithers() is "./smithers.db" relative to the workflow's cwd.
        const ready = await waitForSentinel(dbPath, runId);
        if (!ready) {
            // If we never saw the sentinel, the workflow likely failed to
            // start at all. Capture stderr/stdout to make the failure debuggable.
            proc.kill("SIGKILL");
            const [err, out] = await Promise.all([stderrPromise, stdoutPromise]);
            const filt = (s) => s.split("\n").filter((l) => !l.includes("level=WARN")).join("\n");
            throw new Error(
                `run never started; cwd=${repo.dir} dbExists=${existsSync(dbPath)}\n--- stderr ---\n${filt(err).slice(0, 3000)}\n--- stdout ---\n${filt(out).slice(0, 3000)}`,
            );
        }
        proc.kill(sig);
        const exitCode = await proc.exited;
        // Graceful shutdown marks the run `cancelled` (exit code 2). Older
        // signal-driven exits surfaced as 130/143 or null/undefined depending on
        // bun version; accept any of these so the test pins the durable state
        // (asserted below), not the precise process exit code.
        expect([2, 130, 143, null, undefined]).toContain(exitCode);
        // The run must be durably `cancelled` with its heartbeat cleared — proof
        // that the graceful abort handler ran instead of a hard process.exit().
        const runRow = await waitForRunStatus(dbPath, runId, "cancelled");
        expect(runRow?.status).toBe("cancelled");
        expect(runRow?.heartbeat).toBeNull();
        // DB file should reopen cleanly with no WAL corruption.
        expect(existsSync(dbPath)).toBe(true);
        const db = new Database(dbPath);
        try {
            const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
            expect(Array.isArray(rows)).toBe(true);
            // size sanity
            expect(statSync(dbPath).size).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    } finally {
        try { proc.kill("SIGKILL"); } catch {}
    }
}

testIfDeps("SIGINT mid-run closes sqlite cleanly and leaves the db readable", async () => {
    await runSignalScenario("SIGINT");
}, 60_000);

testIfDeps("SIGTERM mid-run closes sqlite cleanly and leaves the db readable", async () => {
    await runSignalScenario("SIGTERM");
}, 60_000);
