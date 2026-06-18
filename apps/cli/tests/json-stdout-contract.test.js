import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        sqlite,
        adapter: new SmithersDb(db),
    };
}

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 * @param {SmithersDb} adapter
 * @param {Database} sqlite
 */
async function seedJsonContractFixture(repo, adapter, sqlite) {
    const now = Date.now();
    await adapter.insertRun({
        runId: "json-run",
        workflowName: "json-contract",
        workflowPath: "workflow.tsx",
        status: "finished",
        createdAtMs: now - 10_000,
        startedAtMs: now - 9_000,
        finishedAtMs: now - 1_000,
        heartbeatAtMs: null,
        vcsType: "jj",
        vcsRevision: "target",
    });
    await adapter.insertFrame({
        runId: "json-run",
        frameNo: 0,
        createdAtMs: now - 8_000,
        xmlJson: JSON.stringify({
            kind: "element",
            tag: "smithers:workflow",
            props: { name: "json-contract" },
            children: [
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "node-a", label: "Node A", output: "node_output" },
                    children: [],
                },
            ],
        }),
        xmlHash: "hash-0",
        mountedTaskIdsJson: "[]",
        taskIndexJson: "[]",
        note: null,
    });
    await adapter.insertNode({
        runId: "json-run",
        nodeId: "node-a",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: now - 2_000,
        outputTable: "node_output",
        label: "Node A",
    });
    sqlite.exec(`CREATE TABLE IF NOT EXISTS node_output (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      summary TEXT,
      confidence REAL
    );`);
    sqlite
        .query("INSERT INTO node_output (run_id, node_id, iteration, summary, confidence) VALUES (?, ?, ?, ?, ?)")
        .run("json-run", "node-a", 0, "ok", 0.99);
    await adapter.insertAttempt({
        runId: "json-run",
        nodeId: "node-a",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: now - 7_000,
        finishedAtMs: now - 6_000,
        errorJson: null,
        metaJson: JSON.stringify({ kind: "agent" }),
        responseText: "done",
        cached: false,
        jjPointer: "target",
        jjCwd: repo.dir,
    });
    await adapter.insertEventWithNextSeq({
        runId: "json-run",
        timestampMs: now - 5_000,
        type: "NodeFinished",
        payloadJson: JSON.stringify({
            type: "NodeFinished",
            runId: "json-run",
            nodeId: "node-a",
            iteration: 0,
            attempt: 1,
        }),
    });
    const diffJson = JSON.stringify({
        seq: 1,
        baseRef: "target",
        patches: [],
    });
    await adapter.upsertNodeDiffCache({
        runId: "json-run",
        nodeId: "node-a",
        iteration: 0,
        baseRef: "target",
        diffJson,
        computedAtMs: now - 4_000,
        sizeBytes: Buffer.byteLength(diffJson, "utf8"),
    });
    await adapter.upsertWorkspaceState({
        runId: "json-run",
        jjCwd: repo.dir,
        jjCommitId: "target",
        jjOperationId: "op-target",
        createdAtMs: now - 3_000,
    });
    await adapter.insertWorkspaceCheckpoint({
        runId: "json-run",
        nodeId: "node-a",
        iteration: 0,
        attempt: 1,
        seq: 0,
        jjCwd: repo.dir,
        jjCommitId: "target",
        source: "hook",
        tier: 1,
        label: "JSON contract",
        toolUseId: null,
        createdAtMs: now - 2_500,
    });
}

/**
 * @param {string} label
 * @param {{ stdout: string; stderr: string; exitCode: number }} result
 */
function expectStdoutJson(label, result) {
    if (result.exitCode !== 0) {
        throw new Error(`${label} exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    expect(result.stdout.length, `${label} stdout should contain JSON`).toBeGreaterThan(0);
    try {
        JSON.parse(result.stdout);
    }
    catch (error) {
        throw new Error(`${label} stdout is not parseable JSON:\n${result.stdout}\nstderr:\n${result.stderr}`, {
            cause: error,
        });
    }
}

/**
 * @param {string} label
 * @param {{ stdout: string; stderr: string; exitCode: number }} result
 */
function expectStdoutJsonObject(label, result) {
    expectStdoutJson(label, result);
    const parsed = JSON.parse(result.stdout);
    expect(parsed, `${label} stdout should be a JSON object`).toBeObject();
    expect(Array.isArray(parsed), `${label} stdout should not be a JSON array`).toBe(false);
}

describe("CLI --json stdout contract", () => {
    test("json-supporting commands emit only parseable JSON on stdout", async () => {
        const repo = createTempRepo();
        const { sqlite, adapter } = openRepoDb(repo);
        try {
            await seedJsonContractFixture(repo, adapter, sqlite);

            const cases = [
                { label: "why", args: ["why", "json-run", "--json"] },
                { label: "inspect", args: ["inspect", "json-run", "--json"] },
                { label: "events", args: ["events", "json-run", "--json"] },
                { label: "node", args: ["node", "node-a", "-r", "json-run", "--json"] },
                { label: "tree", args: ["tree", "json-run", "--json"] },
                { label: "output", args: ["output", "json-run", "node-a", "--json"] },
                { label: "diff", args: ["diff", "json-run", "node-a", "--json"] },
                { label: "agents doctor", args: ["agents", "doctor", "--json"] },
            ];

            for (const entry of cases) {
                const result = runSmithers(entry.args, {
                    cwd: repo.dir,
                    format: null,
                });
                expectStdoutJson(entry.label, result);
            }

            const objectCases = [
                { label: "snapshots", args: ["snapshots", "json-run", "--json"] },
                { label: "timeline", args: ["timeline", "json-run", "--json"] },
            ];

            for (const entry of objectCases) {
                const result = runSmithers(entry.args, {
                    cwd: repo.dir,
                    format: null,
                });
                expectStdoutJsonObject(entry.label, result);
            }
        }
        finally {
            sqlite.close();
        }
    }, 120_000);
});
