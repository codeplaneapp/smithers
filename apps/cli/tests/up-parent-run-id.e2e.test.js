// Integration tests for lifecycle-linked parentage on CLI-launched child runs
// (issue #1000): `smithers up --parent-run-id <id>` must validate the parent,
// persist the relationship, propagate it through the detached child's argv and
// RunOptions, and surface it in the inspection/list surfaces.
//
// Every scenario drives the real CLI as a Bun subprocess against a real
// sqlite-backed workspace — no mocks anywhere.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { createTempRepo, pinSqliteBackend, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

const TERMINAL = new Set(["finished", "failed", "cancelled", "continued"]);

/**
 * @param {{ dir: string }} repo
 * @param {string} runId
 * @returns {any} terminal inspect payload (`{ run, steps, ... }`)
 */
function waitForTerminalInspect(repo, runId) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = runSmithers(["inspect", runId], { cwd: repo.dir, format: "json" });
        if (result.exitCode === 0 && result.json?.run && TERMINAL.has(result.json.run.status)) {
            return result.json;
        }
        Bun.sleepSync(150);
    }
    throw new Error(`run ${runId} never reached a terminal status`);
}

/**
 * @param {{ dir: string; path: (...parts: string[]) => string }} repo
 * @param {string} runId
 * @returns {string | null}
 */
function readPersistedParentRunId(repo, runId) {
    const dbPath = repo.path("smithers.db");
    expect(existsSync(dbPath), `expected sqlite store at ${dbPath}`).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    try {
        const row = db
            .query("SELECT parent_run_id AS parentRunId FROM _smithers_runs WHERE run_id = ?")
            .get(runId);
        expect(row, `run row missing for ${runId}`).toBeTruthy();
        return row.parentRunId ?? null;
    } finally {
        db.close();
    }
}

describe("up --parent-run-id (lifecycle-linked child runs)", () => {
    test("nested and detached child launches persist the declared parent and surface it in inspect/ps", () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);
        writeTestWorkflow(repo);

        // Root run: no parent.
        const parent = runSmithers(["up", "workflow.tsx", "--run-id", "parent-run"], {
            cwd: repo.dir,
            format: "json",
            timeoutMs: 120_000,
        });
        expect(parent.exitCode, `${parent.stdout}\n${parent.stderr}`).toBe(0);
        expect(readPersistedParentRunId(repo, "parent-run")).toBeNull();

        // Nested child: a foreground launch that declares the root as parent —
        // the shape a workflow step uses when it launches a sub-run itself.
        const child = runSmithers(
            ["up", "workflow.tsx", "--run-id", "child-run", "--parent-run-id", "parent-run"],
            { cwd: repo.dir, format: "json", timeoutMs: 120_000 },
        );
        expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0);
        expect(readPersistedParentRunId(repo, "child-run")).toBe("parent-run");

        // Detached grandchild: --parent-run-id must survive the detached
        // process-argument hop (parent CLI -> spawned child argv -> RunOptions).
        const detached = runSmithers(
            ["up", "workflow.tsx", "--detach", "--run-id", "grandchild-run", "--parent-run-id", "child-run"],
            { cwd: repo.dir, format: "json", timeoutMs: 120_000 },
        );
        expect(detached.exitCode, `${detached.stdout}\n${detached.stderr}`).toBe(0);
        expect(detached.json.runId).toBe("grandchild-run");

        // Inspection surface: the detached grandchild reports its parent.
        const inspected = waitForTerminalInspect(repo, "grandchild-run");
        expect(inspected.run.status).toBe("finished");
        expect(inspected.run.parentRunId).toBe("child-run");
        expect(readPersistedParentRunId(repo, "grandchild-run")).toBe("child-run");

        // The nested child's inspection carries its own parent link too.
        const childInspected = runSmithers(["inspect", "child-run"], { cwd: repo.dir, format: "json" });
        expect(childInspected.exitCode, `${childInspected.stdout}\n${childInspected.stderr}`).toBe(0);
        expect(childInspected.json.run.parentRunId).toBe("parent-run");

        // List surface: `ps` rows expose the whole lineage chain so consumers
        // can build the run tree without per-run inspect round-trips.
        const ps = runSmithers(["ps", "--all"], { cwd: repo.dir, format: "json" });
        expect(ps.exitCode, `${ps.stdout}\n${ps.stderr}`).toBe(0);
        const byId = Object.fromEntries(ps.json.runs.map((row) => [row.id, row]));
        expect(byId["parent-run"].parentRunId).toBeUndefined();
        expect(byId["child-run"].parentRunId).toBe("parent-run");
        expect(byId["grandchild-run"].parentRunId).toBe("child-run");
        // Seeds three real runs (one detached) and polls the CLI, so it needs
        // more than Bun's default 5s per-test budget.
    }, 120_000);

    test("a detached launch with an unknown parent fails loud in the foreground, before spawning", () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);
        writeTestWorkflow(repo);

        const result = runSmithers(
            ["up", "workflow.tsx", "--detach", "--run-id", "orphan-run", "--parent-run-id", "no-such-run"],
            { cwd: repo.dir, format: "json", timeoutMs: 120_000 },
        );
        expect(result.exitCode).toBe(4);
        const all = `${result.stdout}\n${result.stderr}`;
        expect(all).toContain("Parent run not found");
        expect(all).toContain("no-such-run");

        // Nothing was spawned: the run never appears, even after a grace period.
        Bun.sleepSync(1_000);
        const ps = runSmithers(["ps", "--all"], { cwd: repo.dir, format: "json" });
        expect(ps.exitCode, `${ps.stdout}\n${ps.stderr}`).toBe(0);
        expect((ps.json?.runs ?? []).map((row) => row.id)).not.toContain("orphan-run");
    }, 60_000);

    test("a foreground launch with an unknown parent is rejected against the run's own store", () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);
        writeTestWorkflow(repo);

        const result = runSmithers(
            ["up", "workflow.tsx", "--run-id", "orphan-run", "--parent-run-id", "no-such-run"],
            { cwd: repo.dir, format: "json", timeoutMs: 120_000 },
        );
        expect(result.exitCode).toBe(4);
        expect(`${result.stdout}\n${result.stderr}`).toContain("Parent run not found");
    }, 60_000);

    test("self-parentage and --resume conflicts are rejected before any launch", () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);
        writeTestWorkflow(repo);

        const selfParent = runSmithers(
            ["up", "workflow.tsx", "--run-id", "loop-run", "--parent-run-id", "loop-run"],
            { cwd: repo.dir, format: "json" },
        );
        expect(selfParent.exitCode).toBe(4);
        expect(`${selfParent.stdout}\n${selfParent.stderr}`).toContain("cannot equal the run's own");

        const withResume = runSmithers(
            ["up", "workflow.tsx", "--resume", "some-run", "--parent-run-id", "other-run"],
            { cwd: repo.dir, format: "json" },
        );
        expect(withResume.exitCode).toBe(4);
        expect(`${withResume.stdout}\n${withResume.stderr}`).toContain("--parent-run-id can only be set when creating a run");

        const emptyParent = runSmithers(
            ["up", "workflow.tsx", "--run-id", "blank-run", "--parent-run-id", "  "],
            { cwd: repo.dir, format: "json" },
        );
        expect(emptyParent.exitCode).toBe(4);
        expect(`${emptyParent.stdout}\n${emptyParent.stderr}`).toContain("non-empty run ID");
    }, 60_000);
});
