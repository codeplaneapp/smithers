import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { captureSnapshot, loadSnapshot, loadLatestSnapshot, listSnapshots, parseSnapshot, } from "../src/snapshot/index.js";
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}
/**
 * @param {Partial<SnapshotData>} [overrides]
 * @returns {SnapshotData}
 */
function sampleData(overrides = {}) {
    return {
        nodes: [
            { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
            { nodeId: "implement", iteration: 0, state: "pending", lastAttempt: null, outputTable: "out_implement", label: null },
        ],
        outputs: { out_analyze: [{ text: "analysis result" }] },
        ralph: [{ ralphId: "main-loop", iteration: 0, done: false }],
        input: { prompt: "Build something" },
        ...overrides,
    };
}

function representativeLargeData() {
    const body = Array.from({ length: 4096 }, (_, index) => String.fromCharCode(32 + ((index * 29) % 95))).join("");
    return sampleData({
        outputs: {
            agentResults: Array.from({ length: 1536 }, (_, index) => ({
                nodeId: `worker-${index % 24}`,
                iteration: Math.floor(index / 24),
                status: index % 7 === 0 ? "needs-review" : "finished",
                text: `${index}:${body}`,
                usage: { inputTokens: 1200 + index, outputTokens: 400 + (index % 200) },
            })),
        },
    });
}
describe("captureSnapshot", () => {
    test("external SQLite capture rolls back partial content and metadata", async () => {
        const sqlite = new Database(":memory:");
        const descriptor = {
            dialect: "sqlite",
            driver: "external-sqlite",
            queryAllRaw: async (sql, params = []) => sqlite.query(sql).all(...params),
            queryValuesRaw: async (sql, params = []) => sqlite.query(sql).values(...params),
            execute: async (sql, params = []) => { sqlite.query(sql).run(...params); },
            supportsTransactions: true,
            transaction: async (operation) => {
                sqlite.run("BEGIN IMMEDIATE");
                try {
                    const result = await operation();
                    sqlite.run("COMMIT");
                    return result;
                }
                catch (error) {
                    sqlite.run("ROLLBACK");
                    throw error;
                }
            },
        };
        const adapter = new SmithersDb(descriptor);
        await adapter.internalStorage.ensureSchema();
        sqlite.run(`CREATE TRIGGER reject_external_snapshot_ref
            BEFORE INSERT ON _smithers_snapshot_payload_refs
            BEGIN SELECT RAISE(ABORT, 'injected external ref failure'); END`);
        await expect(captureSnapshot(adapter, "external-rollback", 0, sampleData())).rejects.toThrow(/injected external ref failure/);
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(0);
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshots").get().count).toBe(0);
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs").get().count).toBe(0);
        sqlite.run("DROP TRIGGER reject_external_snapshot_ref");
        await captureSnapshot(adapter, "external-rollback", 0, sampleData({ input: { prompt: "external success" } }));
        expect(JSON.parse((await loadSnapshot(adapter, "external-rollback", 0)).inputJson)).toEqual({ prompt: "external success" });
        sqlite.close();
    });
    test("deduplicates repeated representative multi-megabyte states without changing loads", async () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-snapshot-benchmark-"));
        const sqlite = new Database(join(dir, "bench.db"));
        const db = drizzle(sqlite);
        ensureSmithersTables(db);
        const adapter = new SmithersDb(db);
        const data = representativeLargeData();
        const frameCount = 12;
        const captureStart = performance.now();
        for (let frameNo = 0; frameNo < frameCount; frameNo++) await captureSnapshot(adapter, "bench", frameNo, data);
        const captureMs = performance.now() - captureStart;
        const payloads = sqlite.query("SELECT COUNT(*) AS count, SUM(length(nodes_json) + length(outputs_json) + length(ralph_json) + length(input_json)) AS bytes FROM _smithers_snapshot_contents").get();
        const refs = sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs").get().count;
        const uncompressed = JSON.stringify({ nodes: data.nodes, outputs: data.outputs, ralph: data.ralph, input: data.input });
        expect(Buffer.byteLength(uncompressed)).toBeGreaterThan(6_000_000);
        expect(payloads.count).toBe(1);
        expect(refs).toBe(frameCount);
        expect(Number(payloads.bytes)).toBeLessThan(Buffer.byteLength(uncompressed) * 1.01);
        const loadStart = performance.now();
        expect(JSON.parse((await loadSnapshot(adapter, "bench", frameCount - 1)).outputsJson).agentResults).toHaveLength(1536);
        const loadMs = performance.now() - loadStart;
        const baseline = new Database(join(dir, "baseline.db"));
        ensureSmithersTables(drizzle(baseline));
        const insert = baseline.query("INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, vcs_pointer, workflow_hash, content_hash, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)");
        for (let frameNo = 0; frameNo < frameCount; frameNo++) insert.run("bench", frameNo, JSON.stringify(data.nodes), JSON.stringify(data.outputs), JSON.stringify(data.ralph), JSON.stringify(data.input), `baseline-${frameNo}`, frameNo);
        const baselineBytes = baseline.query("PRAGMA page_count").get().page_count * baseline.query("PRAGMA page_size").get().page_size;
        const addressedBytes = sqlite.query("PRAGMA page_count").get().page_count * sqlite.query("PRAGMA page_size").get().page_size;
        console.info(`snapshot benchmark: frames=${frameCount} logicalPayload=${Buffer.byteLength(uncompressed) * frameCount} uniquePayload=${payloads.bytes} baselineSqlite=${baselineBytes} addressedSqlite=${addressedBytes} captureMs=${captureMs.toFixed(2)} loadMs=${loadMs.toFixed(2)}`);
        expect(addressedBytes).toBeLessThan(baselineBytes * 0.2);
        await adapter.deleteSnapshotsAfter("bench", 10);
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(1);
        await adapter.deleteSnapshotsAfter("bench", -1);
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(0);
        baseline.close();
        sqlite.close();
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Windows: a just-closed sqlite handle can outlive close() past even
            // retried rm windows (EBUSY). The dir lives in the ephemeral CI temp
            // area, so leaking it beats failing the test.
        }
    }, 60_000);
    test("cleans replaced and deleted payloads without deleting shared references", async () => {
        const { sqlite, adapter } = createTestDb();
        const shared = sampleData({ outputs: { shared: true } });
        const unique = sampleData({ outputs: { unique: true } });
        await captureSnapshot(adapter, "cleanup-a", 0, shared);
        await captureSnapshot(adapter, "cleanup-b", 0, shared);
        expect(sqlite.query("SELECT ref_count FROM _smithers_snapshot_contents WHERE ref_count = 2").get()).toBeDefined();
        await captureSnapshot(adapter, "cleanup-a", 0, unique);
        expect(sqlite.query("SELECT ref_count FROM _smithers_snapshot_contents WHERE ref_count = 1").get()).toBeDefined();
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(2);
        sqlite.run("DELETE FROM _smithers_snapshots WHERE run_id = 'cleanup-a'");
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshots WHERE run_id = 'cleanup-a'").get().count).toBe(0);
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(1);
        expect(await loadSnapshot(adapter, "cleanup-b", 0)).toBeDefined();
        sqlite.run("DELETE FROM _smithers_snapshots WHERE run_id = 'cleanup-b'");
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(0);
        sqlite.run("INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, created_at_ms) VALUES ('bad', 0, '', '', '', '', 'missing', 0)");
        expect(() => sqlite.run("INSERT INTO _smithers_snapshot_payload_refs (run_id, frame_no, content_hash) VALUES ('bad', 0, 'missing')")).toThrow(/foreign key|missing snapshot content/i);
        sqlite.close();
    });
    test("retires a compact reference when a low-level writer replaces it inline", async () => {
        const { sqlite, adapter } = createTestDb();
        await captureSnapshot(adapter, "inline-replace", 0, sampleData());
        const inline = sampleData({ input: { prompt: "written through the public table" } });
        const nodesJson = JSON.stringify(inline.nodes);
        const outputsJson = JSON.stringify(inline.outputs);
        const ralphJson = JSON.stringify(inline.ralph);
        const inputJson = JSON.stringify(inline.input);
        const contentHash = createHash("sha256")
            .update(JSON.stringify({ nodes: inline.nodes, outputs: inline.outputs, ralph: inline.ralph, input: inline.input }))
            .digest("hex");
        sqlite.query(`UPDATE _smithers_snapshots
            SET nodes_json = ?, outputs_json = ?, ralph_json = ?, input_json = ?, content_hash = ?
            WHERE run_id = 'inline-replace' AND frame_no = 0`)
            .run(nodesJson, outputsJson, ralphJson, inputJson, contentHash);
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs").get().count).toBe(0);
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents").get().count).toBe(0);
        expect(JSON.parse((await loadSnapshot(adapter, "inline-replace", 0)).inputJson)).toEqual(inline.input);
        sqlite.close();
    });
    test("inserts and returns a snapshot row", async () => {
        const { adapter } = createTestDb();
        const snap = await captureSnapshot(adapter, "run-1", 0, sampleData());
        expect(snap.runId).toBe("run-1");
        expect(snap.frameNo).toBe(0);
        expect(snap.contentHash).toBeTruthy();
        expect(typeof snap.createdAtMs).toBe("number");
    });
    test("upserts on conflict", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        const snap2 = await captureSnapshot(adapter, "run-1", 0, sampleData({ input: { prompt: "different" } }));
        expect(snap2.runId).toBe("run-1");
        expect(snap2.frameNo).toBe(0);
        expect(JSON.parse(snap2.inputJson).prompt).toBe("different");
    });
    test("captures multiple frames", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData({
            nodes: [
                { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
                { nodeId: "implement", iteration: 0, state: "running", lastAttempt: 1, outputTable: "out_implement", label: null },
            ],
        }));
        const list = await listSnapshots(adapter, "run-1");
        expect(list.length).toBe(2);
        expect(list[0].frameNo).toBe(0);
        expect(list[1].frameNo).toBe(1);
    });
    test("loads legacy inline snapshots without creating payload references", async () => {
        const { sqlite, adapter } = createTestDb();
        const data = sampleData({ input: { prompt: "legacy-inline" } });
        const raw = JSON.stringify({ nodes: data.nodes, outputs: data.outputs, ralph: data.ralph, input: data.input });
        const contentHash = createHash("sha256").update(raw).digest("hex");
        sqlite.query("INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, created_at_ms) VALUES (?, 0, ?, ?, ?, ?, ?, 1)").run("legacy", JSON.stringify(data.nodes), JSON.stringify(data.outputs), JSON.stringify(data.ralph), JSON.stringify(data.input), contentHash);
        const loaded = await loadSnapshot(adapter, "legacy", 0);
        expect(JSON.parse(loaded.inputJson)).toEqual({ prompt: "legacy-inline" });
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs").get().count).toBe(0);
        sqlite.close();
    });
    test("hydrates the preserved compressed prototype without rewriting it", async () => {
        const { sqlite, adapter } = createTestDb();
        sqlite.run("ALTER TABLE _smithers_snapshots ADD COLUMN payload_hash TEXT");
        sqlite.run(`CREATE TABLE _smithers_snapshot_payloads (
            content_hash TEXT PRIMARY KEY,
            payload_b64 TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        )`);
        const data = sampleData({ input: { prompt: "compressed-prototype" } });
        const raw = JSON.stringify({ nodes: data.nodes, outputs: data.outputs, ralph: data.ralph, input: data.input });
        const contentHash = createHash("sha256").update(raw).digest("hex");
        sqlite.query("INSERT INTO _smithers_snapshot_payloads (content_hash, payload_b64, created_at_ms) VALUES (?, ?, 1)").run(contentHash, gzipSync(Buffer.from(raw)).toString("base64"));
        sqlite.query("INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, payload_hash, created_at_ms) VALUES ('prototype', 0, '', '', '', '', ?, ?, 1)").run(contentHash, contentHash);
        const loaded = await loadSnapshot(adapter, "prototype", 0);
        expect(JSON.parse(loaded.inputJson)).toEqual({ prompt: "compressed-prototype" });
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payloads").get().count).toBe(1);
        expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs").get().count).toBe(0);
        sqlite.close();
    });
});
describe("loadSnapshot", () => {
    test("returns undefined for missing snapshot", async () => {
        const { adapter } = createTestDb();
        const result = await loadSnapshot(adapter, "nonexistent", 0);
        expect(result).toBeUndefined();
    });
    test("returns the correct snapshot", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData());
        const snap = await loadSnapshot(adapter, "run-1", 1);
        expect(snap).toBeDefined();
        expect(snap.frameNo).toBe(1);
    });
});
describe("loadLatestSnapshot", () => {
    test("returns the highest frame_no snapshot", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData());
        await captureSnapshot(adapter, "run-1", 2, sampleData());
        const snap = await loadLatestSnapshot(adapter, "run-1");
        expect(snap).toBeDefined();
        expect(snap.frameNo).toBe(2);
    });
    test("returns undefined for run with no snapshots", async () => {
        const { adapter } = createTestDb();
        const result = await loadLatestSnapshot(adapter, "nonexistent");
        expect(result).toBeUndefined();
    });
});
describe("listSnapshots", () => {
    test("returns empty array for unknown run", async () => {
        const { adapter } = createTestDb();
        const list = await listSnapshots(adapter, "nope");
        expect(list).toEqual([]);
    });
    test("returns summary fields ordered by frame_no", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 2, sampleData());
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData());
        const list = await listSnapshots(adapter, "run-1");
        expect(list.length).toBe(3);
        expect(list[0].frameNo).toBe(0);
        expect(list[1].frameNo).toBe(1);
        expect(list[2].frameNo).toBe(2);
        // Verify summary fields only
        expect(list[0]).toHaveProperty("contentHash");
        expect(list[0]).toHaveProperty("createdAtMs");
    });
});
describe("parseSnapshot", () => {
    test("parses JSON blobs into structured data", async () => {
        const { adapter } = createTestDb();
        const snap = await captureSnapshot(adapter, "run-1", 0, sampleData());
        const parsed = parseSnapshot(snap);
        expect(parsed.runId).toBe("run-1");
        expect(parsed.frameNo).toBe(0);
        expect(Object.keys(parsed.nodes).length).toBe(2);
        expect(parsed.nodes["analyze::0"].state).toBe("finished");
        expect(parsed.nodes["implement::0"].state).toBe("pending");
        expect(parsed.input).toEqual({ prompt: "Build something" });
        expect(Object.keys(parsed.ralph).length).toBe(1);
        expect(parsed.ralph["main-loop"].done).toBe(false);
    });
});
