import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { renderPrettyOutput, runOutputOnce } from "../src/output.js";

function makeStream() {
    let out = "";
    return {
        write(chunk) { out += String(chunk); },
        get value() { return out; },
    };
}

async function openMemoryDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, adapter: new SmithersDb(db) };
}

describe("renderPrettyOutput", () => {
    test("returns (pending) when row is null and status pending", () => {
        expect(renderPrettyOutput({ status: "pending", row: null, schema: null })).toBe("(pending)");
    });
    test("returns (failed) when row is null and status failed", () => {
        expect(renderPrettyOutput({ status: "failed", row: null, schema: null })).toBe("(failed)");
    });
    test("renders schema fields in declared order", () => {
        const response = {
            status: "produced",
            row: { c: 3, a: 1, b: 2 },
            schema: { fields: [
                { name: "a", type: "number", optional: false, nullable: false },
                { name: "b", type: "number", optional: false, nullable: false },
                { name: "c", type: "number", optional: false, nullable: false },
            ] },
        };
        const rendered = renderPrettyOutput(response);
        const lines = rendered.split("\n");
        expect(lines[0]).toBe("a: 1");
        expect(lines[1]).toBe("b: 2");
        expect(lines[2]).toBe("c: 3");
    });
    test("appends extra row keys after declared schema fields", () => {
        const response = {
            status: "produced",
            row: { a: 1, extra: "hi" },
            schema: { fields: [
                { name: "a", type: "number", optional: false, nullable: false },
            ] },
        };
        const rendered = renderPrettyOutput(response);
        expect(rendered).toBe("a: 1\nextra: hi");
    });
});

describe("runOutputOnce", () => {
    test("resolves camelCase output_table keys to the snake_case physical table", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            await adapter.insertRun({
                runId: "run-camel",
                workflowName: "wf",
                status: "finished",
                createdAtMs: 1_000,
                startedAtMs: 1_000,
                finishedAtMs: 2_000,
            });
            // The engine stores the workflow schema key verbatim (camelCase)
            // while the physical table is snake_case.
            await adapter.insertNode({
                runId: "run-camel",
                nodeId: "review-codex",
                iteration: 0,
                state: "done",
                lastAttempt: 1,
                updatedAtMs: 1_500,
                outputTable: "reviewCodex",
                label: "Review (codex)",
            });
            sqlite.run(`CREATE TABLE review_codex (
                run_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                iteration INTEGER NOT NULL DEFAULT 0,
                verdict TEXT,
                PRIMARY KEY (run_id, node_id, iteration)
            )`);
            sqlite.run(`INSERT INTO review_codex (run_id, node_id, iteration, verdict)
                VALUES ('run-camel', 'review-codex', 0, 'approved')`);
            const result = await runOutputOnce({
                adapter,
                runId: "run-camel",
                nodeId: "review-codex",
                json: true,
                pretty: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(0);
            expect(stderr.value).toBe("");
            expect(JSON.parse(stdout.value)).toEqual({ verdict: "approved" });
        } finally {
            sqlite.close();
        }
    });

    test("does not fall back to the snake_case table when a physical camelCase table exists", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            await adapter.insertRun({
                runId: "run-mixed",
                workflowName: "wf",
                status: "finished",
                createdAtMs: 1_000,
                startedAtMs: 1_000,
                finishedAtMs: 2_000,
            });
            await adapter.insertNode({
                runId: "run-mixed",
                nodeId: "review-codex",
                iteration: 0,
                state: "done",
                lastAttempt: 1,
                updatedAtMs: 1_500,
                outputTable: "reviewCodex",
                label: "Review (codex)",
            });
            // A REAL camelCase physical table exists (e.g. a custom drizzle
            // table) but has no row for this node; a snake_case table with a
            // row for the same key also exists. The missing row must surface
            // as null, never as the other table's row.
            sqlite.run(`CREATE TABLE reviewCodex (
                run_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                iteration INTEGER NOT NULL DEFAULT 0,
                verdict TEXT,
                PRIMARY KEY (run_id, node_id, iteration)
            )`);
            sqlite.run(`CREATE TABLE review_codex (
                run_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                iteration INTEGER NOT NULL DEFAULT 0,
                verdict TEXT,
                PRIMARY KEY (run_id, node_id, iteration)
            )`);
            sqlite.run(`INSERT INTO review_codex (run_id, node_id, iteration, verdict)
                VALUES ('run-mixed', 'review-codex', 0, 'should-not-leak')`);
            const result = await runOutputOnce({
                adapter,
                runId: "run-mixed",
                nodeId: "review-codex",
                json: true,
                pretty: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(0);
            expect(stderr.value).toBe("");
            expect(JSON.parse(stdout.value)).toBe(null);
        } finally {
            sqlite.close();
        }
    });

    test("still resolves output_table values already stored as snake_case", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            await adapter.insertRun({
                runId: "run-snake",
                workflowName: "wf",
                status: "finished",
                createdAtMs: 1_000,
                startedAtMs: 1_000,
                finishedAtMs: 2_000,
            });
            // Older runs persisted the physical snake_case name directly.
            await adapter.insertNode({
                runId: "run-snake",
                nodeId: "review-codex",
                iteration: 0,
                state: "done",
                lastAttempt: 1,
                updatedAtMs: 1_500,
                outputTable: "review_codex",
                label: "Review (codex)",
            });
            sqlite.run(`CREATE TABLE review_codex (
                run_id TEXT NOT NULL,
                node_id TEXT NOT NULL,
                iteration INTEGER NOT NULL DEFAULT 0,
                verdict TEXT,
                PRIMARY KEY (run_id, node_id, iteration)
            )`);
            sqlite.run(`INSERT INTO review_codex (run_id, node_id, iteration, verdict)
                VALUES ('run-snake', 'review-codex', 0, 'approved')`);
            const result = await runOutputOnce({
                adapter,
                runId: "run-snake",
                nodeId: "review-codex",
                json: true,
                pretty: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(0);
            expect(stderr.value).toBe("");
            expect(JSON.parse(stdout.value)).toEqual({ verdict: "approved" });
        } finally {
            sqlite.close();
        }
    });

    test("maps InvalidRunId to exit 1", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runOutputOnce({
                adapter,
                runId: "!!bad!!",
                nodeId: "task-a",
                json: true,
                pretty: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("InvalidRunId");
        } finally {
            sqlite.close();
        }
    });

    test("maps RunNotFound to exit 1", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runOutputOnce({
                adapter,
                runId: "missing-run",
                nodeId: "task-a",
                json: true,
                pretty: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("RunNotFound");
        } finally {
            sqlite.close();
        }
    });
});
