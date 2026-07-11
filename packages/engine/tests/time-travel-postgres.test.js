/**
 * Time-travel + resume coverage on the PostgreSQL/PGlite backend.
 *
 * Mirrors the SQLite resume/fork e2e tests (resume-no-time-travel.e2e,
 * resume-with-time-travel.e2e, fork-session.e2e) but drives runWorkflow
 * directly against a single, persistent Postgres descriptor so the engine, the
 * snapshot writer, and the time-travel fork/replay API all share one
 * connection. Exercises the dialect-aware paths converted for Postgres:
 *   - per-frame snapshot capture (captureSnapshotEffect)
 *   - snapshot reads (loadSnapshot / loadLatestSnapshot / listSnapshots)
 *   - restoreDurableStateFromSnapshot on resume (input + output upserts)
 *   - forkRun (snapshot + branch writes, branch reads)
 *
 * Set SMITHERS_TEST_PG_URL to run against a real PostgreSQL (recommended);
 * otherwise an embedded PGlite is booted (slow first run: WASM compile).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import React from "react";
import { Context, Effect, Schema } from "effect";
import { Workflow } from "@smithers-orchestrator/components/components/index";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { captureSnapshot, listSnapshots, loadSnapshot, parseSnapshot } from "@smithers-orchestrator/time-travel/snapshot";
import { replayFromCheckpoint } from "@smithers-orchestrator/time-travel/replay";
import { forkRunEffect, listBranchesEffect } from "@smithers-orchestrator/time-travel/fork";
import { runWorkflow } from "../src/engine.js";
import { Smithers, __builderInternals as I } from "../src/effect/builder.js";

setDefaultTimeout(180_000);

const PG_URL = process.env.SMITHERS_TEST_PG_URL;
const pgConcurrencyTest = PG_URL ? test : test.skip;

const inputSchema = Schema.Struct({ variant: Schema.String });
const outputSchema = Schema.Struct({ value: Schema.Number });

/**
 * Boot a persistent Postgres/PGlite descriptor for the given builder handles
 * (durable engine schema + per-handle output tables) and an adapter over it.
 * Returns the descriptor, adapter, and a teardown.
 * @param {Array<object>} handles
 */
async function bootPg(handles) {
    const config = PG_URL
        ? { provider: "postgres", connectionString: PG_URL }
        : { provider: "pglite" };
    const runtime = await I.createBuilderDbPostgres(config, handles);
    const adapter = new SmithersDb(runtime.db);
    return { db: runtime.db, adapter, close: runtime.close };
}

/**
 * Open an independent client against the same Postgres/PGlite database. A
 * second SmithersDb over the original descriptor would still share one
 * connection and serialize transactions, hiding row-lock races.
 * @param {object} db
 */
async function openPgPeer(db) {
    const pgModule = await import("pg");
    const pg = pgModule.default ?? pgModule;
    const params = db.connection.connectionParameters;
    const connection = new pg.Client(PG_URL
        ? { connectionString: PG_URL }
        : {
            host: params.host,
            port: params.port,
            user: params.user,
            password: params.password,
            database: params.database,
        });
    await connection.connect();
    const adapter = new SmithersDb({ ...db, connection });
    return {
        adapter,
        connection,
        close: async () => {
            let timer;
            const ended = connection.end().then(() => undefined, () => undefined);
            await Promise.race([
                ended,
                new Promise((resolve) => {
                    timer = setTimeout(() => {
                        connection.connection?.stream?.destroy();
                        resolve();
                    }, 1_000);
                }),
            ]);
            clearTimeout(timer);
        },
    };
}

async function within(promise, label, timeoutMs = 15_000) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}

function sharedSnapshotData(marker) {
    return {
        nodes: [{ nodeId: "shared", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out", label: null }],
        outputs: { out: [{ text: marker }] },
        ralph: [],
        input: { prompt: "same" },
    };
}

/**
 * Build a workflow object runWorkflow accepts from a compiled builder node.
 * @param {string} name
 * @param {object} root
 * @param {object} db
 * @param {object} env
 * @param {unknown} decodedInput
 */
function makeWorkflow(name, root, db, env, decodedInput) {
    return {
        db,
        build: (ctx) => React.createElement(Workflow, { name }, I.renderNode(root, ctx, decodedInput, env)),
        opts: {},
    };
}

function uniqueRunId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

describe("time-travel + resume (postgres)", () => {
    pgConcurrencyTest("parallel same-content captures share one payload without deadlocking", async () => {
        const { db, adapter, close } = await bootPg([]);
        const peer = await openPgPeer(db);
        try {
            const marker = uniqueRunId("parallel-pg-content");
            const data = sharedSnapshotData(marker);
            const runA = uniqueRunId("pg-parallel-a");
            const runB = uniqueRunId("pg-parallel-b");
            const [snapshotA, snapshotB] = await within(Promise.all([
                captureSnapshot(adapter, runA, 0, data),
                captureSnapshot(peer.adapter, runB, 0, data),
            ]), "parallel same-content snapshot captures");

            expect(snapshotB.contentHash).toBe(snapshotA.contentHash);
            const content = await adapter.internalStorage.queryOne(
                "SELECT COUNT(*) AS count, MAX(ref_count) AS ref_count FROM _smithers_snapshot_contents WHERE content_hash = ?",
                [snapshotA.contentHash],
            );
            const refs = await adapter.internalStorage.queryOne(
                "SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs WHERE content_hash = ?",
                [snapshotA.contentHash],
            );
            expect(Number(content.count)).toBe(1);
            expect(Number(content.refCount)).toBe(2);
            expect(Number(refs.count)).toBe(2);

            for (const [reader, runId] of [[adapter, runA], [peer.adapter, runB]]) {
                const parsed = parseSnapshot(await loadSnapshot(reader, runId, 0));
                expect(parsed.outputs.out).toEqual([{ text: marker }]);
            }
        }
        finally {
            await peer.close();
            await close();
        }
    });

    pgConcurrencyTest("last-reference deletion racing same-content capture preserves the replacement", async () => {
        const { db, adapter, close } = await bootPg([]);
        const capturePeer = await openPgPeer(db);
        const deletePeer = await openPgPeer(db);
        try {
            const testId = uniqueRunId("last-reference-race-content");
            for (let round = 0; round < 4; round += 1) {
                const marker = `${testId}-${round}`;
                const data = sharedSnapshotData(marker);
                const oldRunId = uniqueRunId(`pg-race-old-${round}`);
                const newRunId = uniqueRunId(`pg-race-new-${round}`);
                const original = await captureSnapshot(adapter, oldRunId, 0, data);
                let release;
                const start = new Promise((resolve) => {
                    release = resolve;
                });
                const capturePromise = (async () => {
                    await start;
                    return await captureSnapshot(capturePeer.adapter, newRunId, 0, data);
                })();
                const deletePromise = (async () => {
                    await start;
                    return await deletePeer.adapter.internalStorage.deleteWhere("_smithers_snapshots", "run_id = ?", [oldRunId]);
                })();
                release();
                const [replacement] = await within(
                    Promise.all([capturePromise, deletePromise]),
                    `last-reference delete/capture race round ${round}`,
                );

                expect(replacement.contentHash).toBe(original.contentHash);
                const content = await adapter.internalStorage.queryOne(
                    "SELECT COUNT(*) AS count, MAX(ref_count) AS ref_count FROM _smithers_snapshot_contents WHERE content_hash = ?",
                    [original.contentHash],
                );
                const refs = await adapter.internalStorage.queryOne(
                    "SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs WHERE content_hash = ?",
                    [original.contentHash],
                );
                expect(Number(content.count)).toBe(1);
                expect(Number(content.refCount)).toBe(1);
                expect(Number(refs.count)).toBe(1);
                expect(await loadSnapshot(adapter, oldRunId, 0)).toBeUndefined();
                const parsed = parseSnapshot(await loadSnapshot(capturePeer.adapter, newRunId, 0));
                expect(parsed.outputs.out).toEqual([{ text: marker }]);
            }
        }
        finally {
            await deletePeer.close();
            await capturePeer.close();
            await close();
        }
    });

    test("deduplicates shared snapshot content and cleans it through real database triggers", async () => {
        const { adapter, close } = await bootPg([]);
        try {
            const data = {
                nodes: [{ nodeId: "shared", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out", label: null }],
                outputs: { out: [{ text: "shared-pglite-content" }] },
                ralph: [],
                input: { prompt: "same" },
            };
            const runA = uniqueRunId("pg-content-a");
            const runB = uniqueRunId("pg-content-b");
            await captureSnapshot(adapter, runA, 0, data);
            await captureSnapshot(adapter, runB, 0, data);
            const shared = await adapter.internalStorage.queryOne("SELECT COUNT(*) AS count, MAX(ref_count) AS ref_count FROM _smithers_snapshot_contents");
            expect(Number(shared.count)).toBe(1);
            expect(Number(shared.refCount)).toBe(2);
            expect(Number((await adapter.internalStorage.queryOne("SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs")).count)).toBe(2);
            await adapter.internalStorage.updateWhere("_smithers_snapshots", {
                nodesJson: "[]",
                outputsJson: '{"inline":true}',
                ralphJson: "[]",
                inputJson: '{"prompt":"inline-pglite"}',
                contentHash: "inline-pglite",
            }, "run_id = ? AND frame_no = ?", [runA, 0]);
            expect(Number((await adapter.internalStorage.queryOne("SELECT COUNT(*) AS count FROM _smithers_snapshot_payload_refs")).count)).toBe(1);
            expect(Number((await adapter.internalStorage.queryOne("SELECT ref_count FROM _smithers_snapshot_contents")).refCount)).toBe(1);
            expect(JSON.parse((await loadSnapshot(adapter, runA, 0)).inputJson)).toEqual({ prompt: "inline-pglite" });
            await adapter.internalStorage.deleteWhere("_smithers_snapshots", "run_id = ?", [runB]);
            expect(Number((await adapter.internalStorage.queryOne("SELECT COUNT(*) AS count FROM _smithers_snapshot_contents")).count)).toBe(0);
        }
        finally {
            await close();
        }
    });

    test("captures snapshots during a run and reads them back", async () => {
        const G = Smithers.workflow({ name: "pg-tt-capture", input: inputSchema });
        const a = G.step("analyze", { output: outputSchema, run: () => ({ value: 1 }) });
        const b = G.step("implement", { output: outputSchema, run: () => ({ value: 2 }) });
        const wf = G.from(G.sequence(a, b));
        const handles = I.collectHandles(wf.node);
        const { db, adapter, close } = await bootPg(handles);
        try {
            const runId = uniqueRunId("pg-tt-capture");
            const result = await Effect.runPromise(
                runWorkflow(makeWorkflow("pg-tt-capture", wf.node, db, Context.empty(), { variant: "A" }), {
                    input: { variant: "A" },
                    runId,
                }),
            );
            expect(result.status).toBe("finished");
            const snaps = await listSnapshots(adapter, runId);
            expect(snaps.length).toBeGreaterThan(0);
            // Snapshot frame numbers come back as JS numbers (int8 type parser).
            expect(typeof snaps[0].frameNo).toBe("number");
            const latest = await loadSnapshot(adapter, runId, snaps[snaps.length - 1].frameNo);
            const parsed = parseSnapshot(latest);
            expect(parsed.nodes["analyze::0"]?.state).toBe("finished");
            expect(parsed.nodes["implement::0"]?.state).toBe("finished");
        } finally {
            await close();
        }
    });

    test("resumes a failed run from durable state and finishes (restoreDurableStateFromSnapshot)", async () => {
        // implement fails on its first attempt with retries=0; resume with a
        // workflow that allows a retry so it can finish.
        let implementCalls = 0;
        const makeGraph = (implementRetries) => {
            const G = Smithers.workflow({ name: "pg-tt-resume", input: inputSchema });
            const analyze = G.step("analyze", { output: outputSchema, run: () => ({ value: 1 }) });
            const implement = G.step("implement", {
                output: outputSchema,
                retry: implementRetries,
                run: () => {
                    implementCalls += 1;
                    if (implementCalls === 1) throw new Error("implement failed");
                    return { value: 2 };
                },
            });
            const test = G.step("test", { output: outputSchema, run: () => ({ value: 3 }) });
            return G.from(G.sequence(analyze, implement, test));
        };
        const failing = makeGraph(0);
        const handles = I.collectHandles(failing.node);
        const { db, adapter, close } = await bootPg(handles);
        try {
            const runId = uniqueRunId("pg-tt-resume");
            const first = await Effect.runPromise(
                runWorkflow(makeWorkflow("pg-tt-resume", failing.node, db, Context.empty(), { variant: "A" }), {
                    input: { variant: "A" },
                    runId,
                }),
            );
            expect(first.status).toBe("failed");
            const firstNodes = await adapter.listNodes(runId);
            expect(firstNodes.find((n) => n.nodeId === "analyze")?.state).toBe("finished");
            expect(firstNodes.find((n) => n.nodeId === "implement")?.state).toBe("failed");

            const upgraded = makeGraph(1);
            const resumed = await Effect.runPromise(
                runWorkflow(makeWorkflow("pg-tt-resume", upgraded.node, db, Context.empty(), { variant: "A" }), {
                    input: { variant: "A" },
                    runId,
                    resume: true,
                }),
            );
            expect(resumed.status).toBe("finished");
            // analyze ran once (resume reuses its output), implement twice, test once.
            const analyzeAttempts = await adapter.listAttempts(runId, "analyze", 0);
            const implementAttempts = await adapter.listAttempts(runId, "implement", 0);
            const testAttempts = await adapter.listAttempts(runId, "test", 0);
            expect(analyzeAttempts).toHaveLength(1);
            expect(implementAttempts).toHaveLength(2);
            expect(testAttempts).toHaveLength(1);
        } finally {
            await close();
        }
    });

    test("resume is idempotent on an already-finished run", async () => {
        let calls = 0;
        const G = Smithers.workflow({ name: "pg-tt-idem", input: inputSchema });
        const done = G.step("done", {
            output: outputSchema,
            run: () => {
                calls += 1;
                return { value: 7 };
            },
        });
        const wf = G.from(done);
        const handles = I.collectHandles(wf.node);
        const { db, adapter, close } = await bootPg(handles);
        try {
            const runId = uniqueRunId("pg-tt-idem");
            const first = await Effect.runPromise(
                runWorkflow(makeWorkflow("pg-tt-idem", wf.node, db, Context.empty(), { variant: "A" }), {
                    input: { variant: "A" },
                    runId,
                }),
            );
            expect(first.status).toBe("finished");
            expect(calls).toBe(1);
            const resumed = await Effect.runPromise(
                runWorkflow(makeWorkflow("pg-tt-idem", wf.node, db, Context.empty(), { variant: "A" }), {
                    input: { variant: "A" },
                    runId,
                    resume: true,
                }),
            );
            expect(resumed.status).toBe("finished");
            expect(calls).toBe(1);
            const attempts = await adapter.listAttempts(runId, "done", 0);
            expect(attempts).toHaveLength(1);
        } finally {
            await close();
        }
    });

    test("forks a finished run from a checkpoint, preserving completed outputs", async () => {
        const G = Smithers.workflow({ name: "pg-tt-fork", input: inputSchema });
        const analyze = G.step("analyze", { output: outputSchema, run: () => ({ value: 1 }) });
        const implement = G.step("implement", { output: outputSchema, run: () => ({ value: 2 }) });
        const test = G.step("test", { output: outputSchema, run: () => ({ value: 3 }) });
        const wf = G.from(G.sequence(analyze, implement, test));
        const handles = I.collectHandles(wf.node);
        const { db, adapter, close } = await bootPg(handles);
        try {
            const parentRunId = uniqueRunId("pg-tt-fork");
            const first = await Effect.runPromise(
                runWorkflow(makeWorkflow("pg-tt-fork", wf.node, db, Context.empty(), { variant: "A" }), {
                    input: { variant: "A" },
                    runId: parentRunId,
                }),
            );
            expect(first.status).toBe("finished");

            // Copy the final snapshot to a fresh checkpoint frame, then replay
            // (fork) from it with implement+test reset to pending.
            const parentSnaps = await listSnapshots(adapter, parentRunId);
            const sourceFrameNo = parentSnaps[parentSnaps.length - 1].frameNo;
            const checkpointFrameNo = sourceFrameNo + 1000;
            const sourceSnap = await loadSnapshot(adapter, parentRunId, sourceFrameNo);
            const parsedSource = parseSnapshot(sourceSnap);
            await captureSnapshot(adapter, parentRunId, checkpointFrameNo, {
                nodes: Object.values(parsedSource.nodes).map((n) => ({
                    nodeId: n.nodeId,
                    iteration: n.iteration,
                    state: n.state,
                    lastAttempt: n.lastAttempt,
                    outputTable: n.outputTable,
                    label: n.label,
                })),
                outputs: parsedSource.outputs,
                ralph: Object.values(parsedSource.ralph).map((r) => ({
                    ralphId: r.ralphId,
                    iteration: r.iteration,
                    done: r.done,
                })),
                input: { variant: "A" },
                vcsPointer: parsedSource.vcsPointer,
                workflowHash: parsedSource.workflowHash,
            });

            const replay = await replayFromCheckpoint(adapter, {
                parentRunId,
                frameNo: checkpointFrameNo,
                resetNodes: ["implement", "test"],
            });
            const forked = parseSnapshot(replay.snapshot);
            expect(forked.nodes["analyze::0"]?.state).toBe("finished");
            expect(forked.nodes["implement::0"]?.state).toBe("pending");
            expect(forked.nodes["test::0"]?.state).toBe("pending");

            // The fork created a branch row pointing at the parent.
            const branches = await Effect.runPromise(listBranchesEffect(adapter, parentRunId));
            expect(branches.some((b) => b.runId === replay.runId)).toBe(true);
            expect(branches[0].parentRunId).toBe(parentRunId);
        } finally {
            await close();
        }
    });

    test("forkRun on its own writes a child snapshot + branch and reads them back", async () => {
        const G = Smithers.workflow({ name: "pg-tt-forkraw", input: inputSchema });
        const a = G.step("a", { output: outputSchema, run: () => ({ value: 1 }) });
        const wf = G.from(a);
        const handles = I.collectHandles(wf.node);
        const { db, adapter, close } = await bootPg(handles);
        try {
            const parentRunId = uniqueRunId("pg-tt-forkraw");
            const first = await Effect.runPromise(
                runWorkflow(makeWorkflow("pg-tt-forkraw", wf.node, db, Context.empty(), { variant: "A" }), {
                    input: { variant: "A" },
                    runId: parentRunId,
                }),
            );
            expect(first.status).toBe("finished");
            const snaps = await listSnapshots(adapter, parentRunId);
            const frameNo = snaps[snaps.length - 1].frameNo;
            const fork = await Effect.runPromise(
                forkRunEffect(adapter, { parentRunId, frameNo, branchLabel: "raw-fork" }).pipe(
                    Effect.provide((await import("@effect/platform-bun/BunContext")).layer),
                ),
            );
            expect(fork.runId).toBeTruthy();
            expect(fork.branch.parentRunId).toBe(parentRunId);
            // Child snapshot (frame 0) is readable.
            const childSnap = await loadSnapshot(adapter, fork.runId, 0);
            expect(childSnap).toBeTruthy();
            expect(parseSnapshot(childSnap).nodes["a::0"]?.state).toBe("finished");
        } finally {
            await close();
        }
    });
});
