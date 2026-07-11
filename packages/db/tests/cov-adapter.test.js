import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { z } from "zod";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { zodToTable } from "../src/zodToTable.js";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";

function createDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, db, adapter: new SmithersDb(db) };
}

const now = 1_700_000_000_000;
const runRow = (runId, status = "running", extra = {}) => ({ runId, workflowName: "wf", status, createdAtMs: now, ...extra });
const nodeRow = (runId, nodeId, state = "pending", extra = {}) => ({ runId, nodeId, iteration: 0, state, updatedAtMs: now, outputTable: "out", label: null, ...extra });

describe("adapter: hijack + ancestry", () => {
    test("requestRunHijack / clearRunHijack round-trip", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("r1"));
        await adapter.requestRunHijack("r1", now + 5, "codex");
        let run = await adapter.getRun("r1");
        expect(run.hijackRequestedAtMs).toBe(now + 5);
        expect(run.hijackTarget).toBe("codex");
        await adapter.clearRunHijack("r1");
        run = await adapter.getRun("r1");
        expect(run.hijackRequestedAtMs).toBeNull();
        expect(run.hijackTarget).toBeNull();
        // hijack with no explicit target → null
        await adapter.requestRunHijack("r1", now + 6);
        run = await adapter.getRun("r1");
        expect(run.hijackTarget).toBeNull();
    });

    test("listRunAncestry walks parent_run_id chain root-first", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("root"));
        await adapter.insertRun(runRow("child", "running", { parentRunId: "root" }));
        await adapter.insertRun(runRow("grand", "running", { parentRunId: "child" }));
        const chain = await adapter.listRunAncestry("grand");
        expect(chain.map((r) => r.runId)).toEqual(["grand", "child", "root"]);
        expect(chain[0].depth).toBe(0);
        expect(chain[2].depth).toBe(2);
    });

    test("listRunAncestry stops at parent cycles and returns each run once", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("a", "running", { parentRunId: "b" }));
        await adapter.insertRun(runRow("b", "running", { parentRunId: "a" }));

        const chain = await adapter.listRunAncestry("a", 5);
        expect(chain.map((r) => r.runId)).toEqual(["a", "b"]);
        expect(new Set(chain.map((r) => r.runId)).size).toBe(chain.length);
        expect(chain.map((r) => r.depth)).toEqual([0, 1]);

        const limited = await adapter.listRunAncestry("a", 1);
        expect(limited.map((r) => r.runId)).toEqual(["a"]);
    });
});

describe("adapter: claim / update-claimed / release", () => {
    test("claimRunForResume claims a stale running run; updateClaimedRun applies a guarded patch; release restores", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("stale", "running", { runtimeOwnerId: null, heartbeatAtMs: now - 100_000 }));
        const claimed = await adapter.claimRunForResume({
            runId: "stale",
            claimOwnerId: "supervisor",
            claimHeartbeatAtMs: now,
            expectedRuntimeOwnerId: null,
            expectedHeartbeatAtMs: now - 100_000,
            staleBeforeMs: now - 1000,
        });
        expect(claimed).toBe(true);

        // Guarded update against the just-claimed owner/heartbeat.
        const updated = await adapter.updateClaimedRun({
            runId: "stale",
            expectedRuntimeOwnerId: "supervisor",
            expectedHeartbeatAtMs: now,
            patch: { status: "running", startedAtMs: now },
        });
        expect(updated).toBe(true);

        // A no-op patch returns true without issuing SQL.
        expect(await adapter.updateClaimedRun({ runId: "stale", expectedRuntimeOwnerId: "supervisor", expectedHeartbeatAtMs: now, patch: {} })).toBe(true);

        // A mismatched expectation updates nothing.
        expect(await adapter.updateClaimedRun({ runId: "stale", expectedRuntimeOwnerId: "someone-else", expectedHeartbeatAtMs: now, patch: { status: "failed" } })).toBe(false);

        await adapter.releaseRunResumeClaim({ runId: "stale", claimOwnerId: "supervisor", restoreRuntimeOwnerId: null, restoreHeartbeatAtMs: null });
        expect((await adapter.getRun("stale")).runtimeOwnerId).toBeNull();
    });
});

describe("adapter: attempts", () => {
    test("updateAttemptEffect + listAttemptsForRun + listAllInProgressAttempts", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("r1"));
        await adapter.insertNode(nodeRow("r1", "n1", "in-progress"));
        await adapter.insertAttemptEffect({ runId: "r1", nodeId: "n1", iteration: 0, attempt: 1, state: "in-progress", startedAtMs: now });
        await adapter.updateAttemptEffect("r1", "n1", 0, 1, { state: "in-progress", metaJson: JSON.stringify({ x: 1 }) });
        const forRun = await adapter.listAttemptsForRun("r1");
        expect(forRun.length).toBe(1);
        const inProgress = await adapter.listAllInProgressAttempts();
        expect(inProgress.some((a) => a.runId === "r1" && a.nodeId === "n1")).toBe(true);
    });
});

describe("adapter: frames", () => {
    test("insertFrame keyframe+delta, reconstructFrameXml, getLastFrame", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("r1"));
        // A LARGE frame so a one-task change produces a delta smaller than the full
        // XML — this makes insertFrame store frame 1 as a delta (the delta-shorter
        // branch), and reconstructFrameXml then re-applies that delta over the
        // keyframe (the apply-delta-in-chain branch).
        const frameXml = (changedState) => canonicalizeXml({
            kind: "element",
            tag: "smithers:workflow",
            props: { name: "wf" },
            children: Array.from({ length: 60 }, (_, i) => ({
                kind: "element",
                tag: "smithers:task",
                props: { id: `task-${i}::0`, state: i === 0 ? changedState : "pending", label: `Task number ${i}` },
                children: [],
            })),
        });
        await adapter.insertFrameEffect({ runId: "r1", frameNo: 0, createdAtMs: now, xmlHash: "h0", xmlJson: frameXml("pending") });
        await adapter.insertFrame({ runId: "r1", frameNo: 1, createdAtMs: now + 1, xmlHash: "h1", xmlJson: frameXml("finished") });
        // Confirm frame 1 was delta-encoded (proves the delta-shorter branch ran).
        const raw = await adapter.listFrames("r1", 10);
        expect(raw.find((f) => f.frameNo === 1)?.encoding).toBe("delta");
        // Reconstruct must re-inflate the delta chain back to the full frame.
        const reconstructed = await Effect.runPromise(adapter.reconstructFrameXml("r1", 1));
        expect(reconstructed).toBe(frameXml("finished"));
        const last = await adapter.getLastFrame("r1");
        expect(last.frameNo).toBe(1);
        // reconstruct a frame that doesn't exist → undefined
        expect(await Effect.runPromise(adapter.reconstructFrameXml("r1", 99))).toBeUndefined();
    });

    test("reconstructFrameXml surfaces a corrupt delta payload through the apply catch", async () => {
        const { sqlite, adapter } = createDb();
        await adapter.insertRun(runRow("r1"));
        // Insert a valid keyframe and a corrupt DELTA frame directly (cold cache),
        // so reconstruct re-applies the bad delta and the apply Effect.try catch runs.
        sqlite.run(`INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash, encoding) VALUES ('r1', 0, ?, '{"kind":"element","tag":"w","props":{},"children":[]}', 'h0', 'keyframe')`, [now]);
        sqlite.run(`INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash, encoding) VALUES ('r1', 1, ?, '{not-valid-delta', 'h1', 'delta')`, [now + 1]);
        const exit = await Effect.runPromiseExit(adapter.reconstructFrameXml("r1", 1));
        expect(exit._tag).toBe("Failure");
    });

    test("insertFrame surfaces a corrupt previous frame through the encode catch", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("r1"));
        // Frame 0 stored with unparseable XML; encoding frame 1 against it throws.
        await adapter.insertFrame({ runId: "r1", frameNo: 0, createdAtMs: now, xmlHash: "h0", xmlJson: "{not-valid-xml" });
        let error;
        try {
            await adapter.insertFrame({ runId: "r1", frameNo: 1, createdAtMs: now + 1, xmlHash: "h1", xmlJson: '{"kind":"element","tag":"w","props":{},"children":[]}' });
        } catch (e) {
            error = e;
        }
        expect(error).toBeDefined();
        expect(String(error)).toMatch(/encode frame delta/);
    });
});

describe("adapter: signals", () => {
    test("insertSignalWithNextSeq allocates + dedupes; listSignals filters", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("r1"));
        const base = { runId: "r1", signalName: "go", correlationId: null, payloadJson: '{"a":1}', receivedAtMs: now, receivedBy: null };
        const seq0 = await adapter.insertSignalWithNextSeq(base);
        expect(seq0).toBe(0);
        // Identical row dedupes to the same seq.
        expect(await adapter.insertSignalWithNextSeq(base)).toBe(0);
        // Different payload allocates the next seq.
        const seq1 = await adapter.insertSignalWithNextSeq({ ...base, payloadJson: '{"a":2}', correlationId: "c1", receivedBy: "u" });
        expect(seq1).toBe(1);
        expect(await adapter.getLastSignalSeq("r1")).toBe(1);

        const all = await adapter.listSignals("r1");
        expect(all.length).toBe(2);
        expect((await adapter.listSignals("r1", { signalName: "go", correlationId: null })).length).toBe(1);
        expect((await adapter.listSignals("r1", { correlationId: "c1" })).length).toBe(1);
        expect((await adapter.listSignals("r1", { receivedAfterMs: now, limit: 1 })).length).toBe(1);
    });
});

describe("adapter: approvals history", () => {
    test("listDecidedApprovals / listAllDecidedApprovals / listApprovalHistoryForNode", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("r1", "running"));
        await adapter.insertNode(nodeRow("r1", "gate", "pending"));
        await adapter.insertOrUpdateApproval({ runId: "r1", nodeId: "gate", iteration: 0, status: "approved", requestedAtMs: now, decidedAtMs: now + 1, decidedBy: "will" });
        const decided = await adapter.listDecidedApprovals("r1");
        expect(decided.length).toBe(1);
        const allDecided = await adapter.listAllDecidedApprovals("r1");
        expect(allDecided.length).toBe(1);
        const history = await adapter.listApprovalHistoryForNode("wf", "gate");
        expect(history.length).toBe(1);
        expect(history[0].runId).toBe("r1");
    });
});

describe("adapter: cache / cron / scorer / memory / scorer effects", () => {
    test("insertCacheEffect + getCache + listCacheByNode", async () => {
        const { adapter } = createDb();
        const row = { cacheKey: "k1", createdAtMs: now, workflowName: "wf", nodeId: "n1", outputTable: "out", schemaSig: "sig", payloadJson: "{}" };
        await adapter.insertCacheEffect(row);
        expect((await adapter.getCache("k1")).cacheKey).toBe("k1");
        expect((await adapter.listCacheByNode("n1", "out")).length).toBe(1);
        expect((await adapter.listCacheByNode("n1")).length).toBe(1);
    });

    test("cron CRUD: upsert / list (enabled-only + all) / updateRunTime / delete", async () => {
        const { adapter } = createDb();
        await adapter.upsertCron({ cronId: "c1", pattern: "* * * * *", workflowPath: "/wf", enabled: true, createdAtMs: now });
        await adapter.upsertCron({ cronId: "c2", pattern: "0 * * * *", workflowPath: "/wf2", enabled: false, createdAtMs: now });
        expect((await adapter.listCrons(true)).length).toBe(1);
        expect((await adapter.listCrons(false)).length).toBe(2);
        await adapter.updateCronRunTime("c1", now + 10, now + 60_000);
        await adapter.deleteCron("c2");
        expect((await adapter.listCrons(false)).length).toBe(1);
    });

    test("listMemoryFacts: all namespaces + scoped", async () => {
        const { sqlite, adapter } = createDb();
        sqlite.run(`INSERT INTO _smithers_memory_facts (namespace, key, value_json, created_at_ms, updated_at_ms) VALUES ('nsA','k1','1',?,?)`, [now, now]);
        sqlite.run(`INSERT INTO _smithers_memory_facts (namespace, key, value_json, created_at_ms, updated_at_ms) VALUES ('nsB','k2','2',?,?)`, [now, now]);
        expect((await adapter.listMemoryFacts()).length).toBe(2);
        expect((await adapter.listMemoryFacts("nsA")).length).toBe(1);
    });

    test("insertScorerResult + listScorerResults (with + without nodeId)", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("r1"));
        await adapter.insertScorerResult({ id: "s1", runId: "r1", nodeId: "n1", iteration: 0, attempt: 0, scorerId: "sc", scorerName: "Scorer", source: "eval", score: 0.9, scoredAtMs: now });
        expect((await adapter.listScorerResults("r1")).length).toBe(1);
        expect((await adapter.listScorerResults("r1", "n1")).length).toBe(1);
    });
});

describe("adapter: output tables + physical table checks", () => {
    test("upsertOutputRowEffect, getRawNodeOutput, deleteOutputRowEffect, hasPhysicalTable", async () => {
        const { sqlite, db, adapter } = createDb();
        const schema = z.object({ summary: z.string() });
        const table = zodToTable("out_tbl", schema);
        sqlite.exec(zodToCreateTableSQL("out_tbl", schema));
        await adapter.upsertOutputRowEffect(table, { runId: "r1", nodeId: "n1", iteration: 0 }, { summary: "hi" });
        const row = await adapter.getRawNodeOutput("out_tbl", "r1", "n1");
        expect(row.summary).toBe("hi");
        expect(await adapter.hasPhysicalTable("out_tbl")).toBe(true);
        expect(await adapter.hasPhysicalTable("does_not_exist")).toBe(false);
        await adapter.deleteOutputRowEffect("out_tbl", { runId: "r1", nodeId: "n1", iteration: 0 });
        expect(await adapter.getRawNodeOutput("out_tbl", "r1", "n1")).toBeNull();
    });

    test("getRawNodeOutput on a missing table recovers to null", async () => {
        const { adapter } = createDb();
        expect(await adapter.getRawNodeOutput("phantom_tbl", "r1", "n1")).toBeNull();
    });

    test("deleteOutputRowEffect resolves a camelCase output key to its snake_case physical table", async () => {
        // Node rows persist the workflow schema KEY (`tfCandidate`) while
        // createSmithers creates the physical table via camelToSnake
        // (`tf_candidate`). `smithers retry-task` deletes through an adapter
        // opened without the workflow's output schema, so the adapter must
        // fall back to the naming convention instead of failing with
        // "Output table tfCandidate is missing runId/nodeId columns".
        const { sqlite, adapter } = createDb();
        const schema = z.object({ summary: z.string() });
        sqlite.exec(zodToCreateTableSQL("tf_candidate", schema));
        sqlite.run("INSERT INTO tf_candidate (run_id, node_id, iteration, summary) VALUES ('r1', 'n1', 0, 'hi')");
        await adapter.deleteOutputRowEffect("tfCandidate", { runId: "r1", nodeId: "n1", iteration: 0 });
        expect(sqlite.query("SELECT COUNT(*) AS count FROM tf_candidate").get().count).toBe(0);
    });
});

describe("adapter: frame-truncation deletes", () => {
    test("deleteSnapshotsAfter + deleteVcsTagsAfter run against the durability tables", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("r1"));
        // These durability tables exist after ensure; deleting past a frame is a no-op-safe write.
        await adapter.deleteSnapshotsAfter("r1", 5);
        await adapter.deleteVcsTagsAfter("r1", 5);
    });
});

describe("adapter: write() failure path", () => {
    test("a write against a dropped table surfaces a DB_WRITE_FAILED SmithersError", async () => {
        const { sqlite, adapter } = createDb();
        sqlite.run(`DROP TABLE _smithers_cron`);
        let error;
        try {
            await adapter.upsertCron({ cronId: "x", pattern: "* * * * *", workflowPath: "/", enabled: true, createdAtMs: now });
        } catch (e) {
            error = e;
        }
        expect(error).toBeDefined();
        // The write() catch wraps the driver failure into a labelled SmithersError.
        expect(String(error)).toMatch(/upsert cron/);
    });
});

describe("adapter: Effect-suffixed wrappers delegate to their base methods", () => {
    test("every *Effect wrapper resolves for a seeded run", async () => {
        const { sqlite, db, adapter } = createDb();
        await adapter.insertRun(runRow("r1"));
        await adapter.insertNode(nodeRow("r1", "n1", "in-progress"));
        await adapter.insertAttempt({ runId: "r1", nodeId: "n1", iteration: 0, attempt: 1, state: "in-progress", startedAtMs: now });
        await adapter.insertToolCall({ runId: "r1", nodeId: "n1", iteration: 0, attempt: 1, seq: 0, toolName: "Bash", startedAtMs: now, status: "ok" });
        await adapter.insertEventWithNextSeq({ runId: "r1", timestampMs: now, type: "run.started", payloadJson: "{}" });
        await adapter.upsertCron({ cronId: "c1", pattern: "* * * * *", workflowPath: "/", enabled: true, createdAtMs: now });
        const schema = z.object({ v: z.number() });
        const table = zodToTable("eff_out", schema);
        sqlite.exec(zodToCreateTableSQL("eff_out", schema));
        await adapter.upsertOutputRow(table, { runId: "r1", nodeId: "n1", iteration: 0 }, { v: 1 });

        await adapter.updateRunEffect("r1", { status: "running", heartbeatAtMs: now + 5 });
        expect((await adapter.getRunEffect("r1")).runId).toBe("r1");
        expect(Array.isArray(await adapter.listRunsEffect(10))).toBe(true);
        expect(Array.isArray(await adapter.listStaleRunningRunsEffect(now + 1))).toBe(true);
        expect(typeof (await adapter.claimRunForResumeEffect({ runId: "r1", claimOwnerId: "o", claimHeartbeatAtMs: now, expectedRuntimeOwnerId: null, expectedHeartbeatAtMs: null, staleBeforeMs: now, expectedStatus: "running", requireStale: false }))).toBe("boolean");
        await adapter.releaseRunResumeClaimEffect({ runId: "r1", claimOwnerId: "o", restoreRuntimeOwnerId: null, restoreHeartbeatAtMs: null });
        expect(Array.isArray(await adapter.listNodeIterationsEffect("r1", "n1"))).toBe(true);
        expect(Array.isArray(await adapter.listNodesEffect("r1"))).toBe(true);
        expect(Array.isArray(await adapter.listAttemptsEffect("r1", "n1", 0))).toBe(true);
        expect(Array.isArray(await adapter.listAttemptsForRunEffect("r1"))).toBe(true);
        expect(Array.isArray(await adapter.listToolCallsEffect("r1", "n1", 0))).toBe(true);
        expect(await adapter.getRawNodeOutputForIterationEffect("eff_out", "r1", "n1", 0)).toBeDefined();
        await adapter.insertEventWithNextSeqEffect({ runId: "r1", timestampMs: now + 1, type: "run.progress", payloadJson: "{}" });
        expect(typeof (await adapter.getLastEventSeqEffect("r1"))).toBe("number");
        expect(Array.isArray(await adapter.listEventHistoryEffect("r1"))).toBe(true);
        expect(typeof (await adapter.countEventHistoryEffect("r1"))).toBe("number");
        expect(Array.isArray(await adapter.listEventsByTypeEffect("r1", "run.started"))).toBe(true);
        expect(Array.isArray(await adapter.listPendingApprovalsEffect("r1"))).toBe(true);
        expect(Array.isArray(await adapter.listDecidedApprovalsEffect("r1"))).toBe(true);
        expect(Array.isArray(await adapter.listAllDecidedApprovalsEffect("r1"))).toBe(true);
        expect(await adapter.getLastFrameEffect("r1")).toBeUndefined();
        expect(Array.isArray(await adapter.listCacheByNodeEffect("n1", "eff_out"))).toBe(true);
        expect(Array.isArray(await adapter.listCronsEffect(true))).toBe(true);
        await adapter.updateCronRunTimeEffect("c1", now, now + 1000);
        expect(Array.isArray(await adapter.listScorerResultsEffect("r1"))).toBe(true);
    });
});
