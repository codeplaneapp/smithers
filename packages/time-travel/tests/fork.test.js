import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { captureSnapshot } from "../src/snapshot/index.js";
import { forkRun, listBranches, getBranchInfo } from "../src/fork/index.js";
import { parseSnapshot, loadSnapshot } from "../src/snapshot/index.js";
import { parseAgentCheckpointSnapshot } from "../src/snapshot/agentCheckpointSnapshot.js";
import { resolveForkAgentState } from "../../engine/src/resolveForkSessionMessages.js";
import { acquireRewindLock } from "../src/acquireRewindLock.js";
import { jumpToFrame } from "../src/jumpToFrame.js";
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
      {
        nodeId: "implement",
        iteration: 0,
        state: "pending",
        lastAttempt: null,
        outputTable: "out_implement",
        label: null,
      },
    ],
    outputs: { out_analyze: [{ text: "analysis" }] },
    ralph: [{ ralphId: "loop", iteration: 0, done: false }],
    input: { prompt: "Build X" },
    ...overrides,
  };
}
describe("forkRun", () => {
  test("copies only provenance for rows present in the selected snapshot", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(
      adapter,
      "parent-provenance",
      1,
      sampleData({ outputs: { out_analyze: [{ nodeId: "analyze", iteration: 0, text: "analysis" }] } }),
    );
    const client = adapter.db.session.client;
    client
      .query(
        `INSERT INTO _smithers_output_provenance (run_id, output_table, node_id, iteration, seq) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .run("parent-provenance", "out_analyze", "analyze", 0, 4, "parent-provenance", "out_later", "later", 0, 5);
    const result = await forkRun(adapter, { parentRunId: "parent-provenance", frameNo: 1 });
    const rows = client
      .query(`SELECT output_table, node_id, seq FROM _smithers_output_provenance WHERE run_id = ? ORDER BY seq`)
      .all(result.runId);
    expect(rows).toEqual([{ output_table: "out_analyze", node_id: "analyze", seq: 4 }]);
  });
  test("a new child output allocates seq after the max inherited provenance seq", async () => {
    const { adapter, db, sqlite } = createTestDb();
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS out_analyze (run_id TEXT NOT NULL, node_id TEXT NOT NULL, iteration INTEGER NOT NULL, text TEXT, PRIMARY KEY (run_id, node_id, iteration))`,
    );
    const { sqliteTable, text: textCol, integer } = await import("drizzle-orm/sqlite-core");
    const outAnalyze = sqliteTable("out_analyze", {
      runId: textCol("run_id").notNull(),
      nodeId: textCol("node_id").notNull(),
      iteration: integer("iteration").notNull(),
      text: textCol("text"),
    });
    await captureSnapshot(
      adapter,
      "parent-alloc",
      1,
      sampleData({ outputs: { out_analyze: [{ nodeId: "analyze", iteration: 0, text: "analysis" }] } }),
    );
    const client = adapter.db.session.client;
    client
      .query(
        `INSERT INTO _smithers_output_provenance (run_id, output_table, node_id, iteration, seq) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("parent-alloc", "out_analyze", "analyze", 0, 4);
    const result = await forkRun(adapter, { parentRunId: "parent-alloc", frameNo: 1 });
    await adapter.upsertOutputRow(
      outAnalyze,
      { runId: result.runId, nodeId: "child-new", iteration: 0 },
      { text: "fresh" },
    );
    const rows = client
      .query(`SELECT node_id, seq FROM _smithers_output_provenance WHERE run_id = ? ORDER BY seq`)
      .all(result.runId);
    expect(rows).toEqual([
      { node_id: "analyze", seq: 4 },
      { node_id: "child-new", seq: 5 },
    ]);
  });
  test("creates a new run with snapshot at frame 0", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 3, sampleData());
    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 3,
    });
    expect(result.runId).toBeTruthy();
    expect(result.runId).not.toBe("parent-run");
    expect(result.branch.parentRunId).toBe("parent-run");
    expect(result.branch.parentFrameNo).toBe(3);
    expect(result.snapshot.frameNo).toBe(0);
  });
  test("copies snapshot data to child run", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 2, sampleData());
    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 2,
    });
    const childSnap = await loadSnapshot(adapter, result.runId, 0);
    expect(childSnap).toBeDefined();
    const parsed = parseSnapshot(childSnap);
    expect(parsed.input).toEqual({ prompt: "Build X" });
    expect(Object.keys(parsed.nodes).length).toBe(2);
  });
  test("applies input overrides", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 1, sampleData());
    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 1,
      inputOverrides: { prompt: "Build Y", extra: "data" },
    });
    const childSnap = await loadSnapshot(adapter, result.runId, 0);
    const parsed = parseSnapshot(childSnap);
    expect(parsed.input).toEqual({ prompt: "Build Y", extra: "data" });
  });
  test("resets specified nodes to pending", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(
      adapter,
      "parent-run",
      1,
      sampleData({
        nodes: [
          {
            nodeId: "analyze",
            iteration: 0,
            state: "finished",
            lastAttempt: 1,
            outputTable: "out_analyze",
            label: null,
          },
          {
            nodeId: "implement",
            iteration: 0,
            state: "finished",
            lastAttempt: 2,
            outputTable: "out_implement",
            label: null,
          },
        ],
      }),
    );
    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 1,
      resetNodes: ["implement"],
    });
    const childSnap = await loadSnapshot(adapter, result.runId, 0);
    const parsed = parseSnapshot(childSnap);
    expect(parsed.nodes["analyze::0"].state).toBe("finished");
    expect(parsed.nodes["implement::0"].state).toBe("pending");
    expect(parsed.nodes["implement::0"].lastAttempt).toBeNull();
  });
  // Contract pin for the fork half of https://github.com/smithersai/smithers/issues/584.
  // `resetNodes` resets ONLY what the caller named. `implement` consumed
  // `analyze`'s output, but a fork that resets `analyze` alone leaves
  // `implement` finished, still carrying the parent's output. If someone
  // teaches fork to expand to downstream dependents, this test fails and the
  // contract change has to be made deliberately.
  test("does not reset a downstream dependent of a reset node", async () => {
    const { adapter } = createTestDb();
    const dependentNodes = [
      { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
      {
        nodeId: "implement",
        iteration: 0,
        state: "finished",
        lastAttempt: 2,
        outputTable: "out_implement",
        label: null,
      },
    ];
    await captureSnapshot(
      adapter,
      "parent-dependents",
      1,
      sampleData({
        nodes: dependentNodes,
        // `implement` consumed `analyze`'s output to produce its own.
        outputs: { out_analyze: [{ text: "analysis" }], out_implement: [{ text: "built from analysis" }] },
      }),
    );

    const result = await forkRun(adapter, {
      parentRunId: "parent-dependents",
      frameNo: 1,
      resetNodes: ["analyze"],
    });

    const parsed = parseSnapshot(await loadSnapshot(adapter, result.runId, 0));
    expect(parsed.nodes["analyze::0"]).toMatchObject({ state: "pending", lastAttempt: null });
    expect(parsed.nodes["implement::0"]).toMatchObject({ state: "finished", lastAttempt: 2 });
    expect(parsed.outputs.out_implement).toEqual([{ text: "built from analysis" }]);

    // The documented remedy: name the dependent too.
    const withDependent = await forkRun(adapter, {
      parentRunId: "parent-dependents",
      frameNo: 1,
      resetNodes: ["analyze", "implement"],
    });
    const bothReset = parseSnapshot(await loadSnapshot(adapter, withDependent.runId, 0));
    expect(bothReset.nodes["analyze::0"]).toMatchObject({ state: "pending", lastAttempt: null });
    expect(bothReset.nodes["implement::0"]).toMatchObject({ state: "pending", lastAttempt: null });
  });
  test("resets a single iteration when given a fully-qualified nodeId::iteration key", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(
      adapter,
      "parent-iterations",
      1,
      sampleData({
        nodes: [
          { nodeId: "loop", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_loop", label: null },
          { nodeId: "loop", iteration: 1, state: "finished", lastAttempt: 1, outputTable: "out_loop", label: null },
        ],
        outputs: {},
      }),
    );

    const exact = await forkRun(adapter, {
      parentRunId: "parent-iterations",
      frameNo: 1,
      resetNodes: ["loop::1"],
    });
    const exactNodes = parseSnapshot(await loadSnapshot(adapter, exact.runId, 0)).nodes;
    expect(exactNodes["loop::0"].state).toBe("finished");
    expect(exactNodes["loop::1"].state).toBe("pending");

    const base = await forkRun(adapter, {
      parentRunId: "parent-iterations",
      frameNo: 1,
      resetNodes: ["loop"],
    });
    const baseNodes = parseSnapshot(await loadSnapshot(adapter, base.runId, 0)).nodes;
    expect(baseNodes["loop::0"].state).toBe("pending");
    expect(baseNodes["loop::1"].state).toBe("pending");
  });
  test("inherits completed checkpoints while reset nodes start fresh with parent-deletion safety", async () => {
    const { adapter } = createTestDb();
    await adapter.insertRun({
      runId: "parent-checkpoints",
      workflowName: "checkpoint-parent",
      status: "finished",
      createdAtMs: 1,
      startedAtMs: 2,
      finishedAtMs: 300,
    });
    const hashes = {};
    for (const [nodeId, attempt] of [
      ["analyze", 1],
      ["implement", 2],
    ]) {
      const checkpointJson = JSON.stringify({ codec: "test.fork", version: 1, payload: { nodeId } });
      const contentHash = createHash("sha256").update(checkpointJson).digest("hex");
      hashes[nodeId] = contentHash;
      await adapter.insertAttempt({
        runId: "parent-checkpoints",
        nodeId,
        iteration: 0,
        attempt,
        state: "finished",
        startedAtMs: 100 + attempt,
        finishedAtMs: 200 + attempt,
        heartbeatAtMs: null,
        heartbeatDataJson: null,
        errorJson: null,
        jjPointer: null,
        cached: false,
        metaJson: JSON.stringify({ agentId: `agent-${nodeId}` }),
        responseText: null,
        jjCwd: null,
      });
      await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoint_contents", {
        contentHash,
        checkpointJson,
        sizeBytes: Buffer.byteLength(checkpointJson, "utf8"),
        createdAtMs: 250 + attempt,
      });
      await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoints", {
        runId: "parent-checkpoints",
        nodeId,
        iteration: 0,
        attempt,
        sequence: 0,
        contentHash,
        codec: "test.fork",
        version: 1,
        agentId: `agent-${nodeId}`,
        purpose: "turn",
        createdAtMs: 250 + attempt,
      });
    }
    await captureSnapshot(
      adapter,
      "parent-checkpoints",
      7,
      sampleData({
        outputs: {},
        nodes: [
          {
            nodeId: "analyze",
            iteration: 0,
            state: "finished",
            lastAttempt: 1,
            outputTable: "out_analyze",
            label: null,
          },
          {
            nodeId: "implement",
            iteration: 0,
            state: "finished",
            lastAttempt: 2,
            outputTable: "out_implement",
            label: null,
          },
        ],
      }),
    );

    const result = await forkRun(adapter, {
      parentRunId: "parent-checkpoints",
      frameNo: 7,
      resetNodes: ["implement"],
    });
    const childRefs = await adapter.listAgentCheckpointRefs(result.runId);
    expect(childRefs.map((ref) => [ref.nodeId, ref.attempt, ref.contentHash])).toEqual([
      ["analyze", 1, hashes.analyze],
    ]);
    const inheritedAttempts = await adapter.listAttemptsForRun(result.runId);
    expect(inheritedAttempts.map((attempt) => attempt.nodeId)).toEqual(["analyze"]);
    expect(await adapter.listAttempts(result.runId, "implement", 0)).toEqual([]);
    for (const attempt of inheritedAttempts) {
      expect(JSON.parse(attempt.metaJson)).toMatchObject({
        agentId: `agent-${attempt.nodeId}`,
        inheritedCheckpointFrom: {
          runId: "parent-checkpoints",
          frameNo: 7,
          nodeId: attempt.nodeId,
          iteration: 0,
          attempt: attempt.attempt,
        },
      });
    }
    const childSnapshotRow = await loadSnapshot(adapter, result.runId, 0);
    const childSnapshot = parseSnapshot(childSnapshotRow);
    expect(childSnapshot.nodes["analyze::0"].state).toBe("finished");
    expect(childSnapshot.nodes["implement::0"]).toMatchObject({ state: "pending", lastAttempt: null });
    const childCheckpointSnapshot = parseAgentCheckpointSnapshot(
      JSON.parse(childSnapshotRow.outputsJson),
      JSON.parse(childSnapshotRow.nodesJson),
      childSnapshotRow.createdAtMs,
    );
    expect(childCheckpointSnapshot.provenance.attempts.map((tuple) => tuple.slice(0, 3))).toEqual([["analyze", 0, 1]]);
    expect([...childCheckpointSnapshot.horizons.keys()]).toEqual([JSON.stringify(["analyze", 0, 1])]);

    // The projected frame must itself remain a valid source for another fork.
    const grandchild = await forkRun(adapter, { parentRunId: result.runId, frameNo: 0 });
    expect((await adapter.listAgentCheckpointRefs(grandchild.runId)).map((ref) => ref.contentHash)).toEqual([
      hashes.analyze,
    ]);

    // A later child attempt can also be rewound to the projected frame 0.
    // This exercises strict metadata parsing and exact attempt restoration in
    // the destructive path, not only when frame 0 is used as another fork.
    await adapter.insertFrame({
      runId: result.runId,
      frameNo: 0,
      createdAtMs: childSnapshotRow.createdAtMs,
      xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: {} }),
      xmlHash: "child-frame-0",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "fork frame",
    });
    await adapter.insertFrame({
      runId: result.runId,
      frameNo: 1,
      createdAtMs: childSnapshotRow.createdAtMs + 1,
      xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { frame: 1 } }),
      xmlHash: "child-frame-1",
      mountedTaskIdsJson: "[]",
      taskIndexJson: "[]",
      note: "later frame",
    });
    await adapter.insertNode({
      runId: result.runId,
      nodeId: "analyze",
      iteration: 0,
      state: "failed",
      lastAttempt: 2,
      updatedAtMs: childSnapshotRow.createdAtMs + 1,
      outputTable: "out_analyze",
      label: null,
    });
    await adapter.insertAttempt({
      runId: result.runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 2,
      state: "failed",
      startedAtMs: childSnapshotRow.createdAtMs + 1,
      finishedAtMs: childSnapshotRow.createdAtMs + 1,
      cached: false,
    });
    await jumpToFrame({
      adapter,
      runId: result.runId,
      frameNo: 0,
      confirm: true,
      getCurrentPointerImpl: async () => null,
      revertToPointerImpl: async () => ({ success: true }),
    });
    expect((await adapter.listAttempts(result.runId, "analyze", 0)).map((attempt) => attempt.attempt)).toEqual([1]);
    expect((await adapter.listAgentCheckpointRefs(result.runId)).map((ref) => ref.contentHash)).toEqual([
      hashes.analyze,
    ]);

    await adapter.internalStorage.deleteWhere("_smithers_attempts", "run_id = ?", ["parent-checkpoints"]);
    await adapter.pruneOrphanedAgentCheckpointContents();
    expect(await adapter.listAgentCheckpointRefs("parent-checkpoints")).toEqual([]);
    expect(await adapter.getAgentCheckpoint(hashes.analyze)).not.toBeNull();
    expect(await adapter.getAgentCheckpoint(hashes.implement)).toBeNull();
    expect(await adapter.listAgentCheckpointRefs(result.runId)).toHaveLength(1);
  });
  test("rehydrates an older frame's exact checkpoint after retry/reset cleanup", async () => {
    const { adapter } = createTestDb();
    const runId = "parent-retried-after-snapshot";
    const checkpointJson = JSON.stringify({ codec: "test.fork", version: 1, payload: { cursor: "frame-7" } });
    const contentHash = createHash("sha256").update(checkpointJson).digest("hex");
    const originalMeta = JSON.stringify({
      agentId: "agent-analyze",
      agentConversation: [{ role: "assistant", content: "old" }],
    });
    await adapter.insertAttempt({
      runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 100,
      finishedAtMs: 200,
      cached: false,
      metaJson: originalMeta,
      responseText: "old response",
    });
    await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoint_contents", {
      contentHash,
      checkpointJson,
      sizeBytes: Buffer.byteLength(checkpointJson, "utf8"),
      createdAtMs: 150,
    });
    await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoints", {
      runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      sequence: 0,
      contentHash,
      codec: "test.fork",
      version: 1,
      agentId: "agent-analyze",
      purpose: "turn",
      createdAtMs: 150,
    });
    await captureSnapshot(adapter, runId, 7, sampleData());

    // This is the durable effect of reset attempt reuse: the old attempt ref
    // and now-orphaned bytes disappear, and the same attempt key is replaced.
    await adapter.internalStorage.deleteWhere("_smithers_attempts", "run_id = ? AND node_id = ?", [runId, "analyze"]);
    await adapter.pruneOrphanedAgentCheckpointContents();
    await adapter.insertAttempt({
      runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      state: "failed",
      startedAtMs: 300,
      finishedAtMs: 400,
      cached: false,
      metaJson: JSON.stringify({ resetGeneration: 2 }),
    });
    expect(await adapter.getAgentCheckpoint(contentHash)).toBeNull();

    const fork = await forkRun(adapter, { parentRunId: runId, frameNo: 7 });
    const refs = await adapter.listAgentCheckpointRefs(fork.runId);
    expect(refs.map((ref) => [ref.attempt, ref.sequence, ref.contentHash])).toEqual([[1, 0, contentHash]]);
    expect(await adapter.getAgentCheckpoint(contentHash)).toMatchObject({ checkpointJson });
    const [attempt] = await adapter.listAttempts(fork.runId, "analyze", 0);
    expect(attempt).toMatchObject({ state: "finished", responseText: "old response" });
    expect(JSON.parse(attempt.metaJson)).toMatchObject(JSON.parse(originalMeta));
  });

  test("copies checkpoint producer and successful consumer lineage for downstream task forks", async () => {
    const { adapter } = createTestDb();
    const runId = "parent-checkpoint-consumer";
    const checkpointJson = JSON.stringify({ codec: "test.fork", version: 1, payload: { cursor: "produced" } });
    const contentHash = createHash("sha256").update(checkpointJson).digest("hex");
    await adapter.insertAttempt({
      runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      state: "failed",
      startedAtMs: 100,
      finishedAtMs: 150,
      cached: false,
      metaJson: JSON.stringify({
        agentCheckpoint: { contentHash, sequence: 0, codec: "test.fork", version: 1 },
      }),
    });
    await adapter.insertAttempt({
      runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 2,
      state: "finished",
      startedAtMs: 160,
      finishedAtMs: 220,
      cached: false,
      metaJson: JSON.stringify({
        resumedFromCheckpoint: { contentHash, sequence: 0 },
        agentConversation: [
          { role: "user", content: "continue" },
          { role: "assistant", content: "completed from checkpoint" },
        ],
      }),
      responseText: "completed from checkpoint",
    });
    await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoint_contents", {
      contentHash,
      checkpointJson,
      sizeBytes: Buffer.byteLength(checkpointJson, "utf8"),
      createdAtMs: 120,
    });
    await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoints", {
      runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      sequence: 0,
      contentHash,
      codec: "test.fork",
      version: 1,
      agentId: "agent-analyze",
      purpose: "turn",
      createdAtMs: 120,
    });
    await captureSnapshot(
      adapter,
      runId,
      9,
      sampleData({
        nodes: [
          {
            nodeId: "analyze",
            iteration: 0,
            state: "finished",
            lastAttempt: 2,
            outputTable: "out_analyze",
            label: null,
          },
        ],
      }),
    );

    const fork = await forkRun(adapter, { parentRunId: runId, frameNo: 9 });
    const attempts = await adapter.listAttempts(fork.runId, "analyze", 0);
    expect(attempts.map((attempt) => [attempt.attempt, attempt.state])).toEqual([
      [2, "finished"],
      [1, "failed"],
    ]);
    expect((await adapter.listAgentCheckpointRefs(fork.runId)).map((ref) => ref.attempt)).toEqual([1]);
    const downstream = resolveForkAgentState(attempts, "analyze", "downstream");
    expect(downstream.sourceAttempt.attempt).toBe(2);
    expect(downstream.checkpointRef).toBeNull();
    expect(downstream.messages).toEqual([
      { role: "user", content: "continue" },
      { role: "assistant", content: "completed from checkpoint" },
    ]);
  });
  test("does not inherit a same-millisecond checkpoint created after the selected snapshot", async () => {
    const { adapter } = createTestDb();
    await adapter.insertAttempt({
      runId: "parent-checkpoint-horizon",
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 100,
      finishedAtMs: 200,
      cached: false,
    });
    const snapshot = await captureSnapshot(adapter, "parent-checkpoint-horizon", 2, sampleData());
    const checkpointJson = JSON.stringify({ codec: "test.fork", version: 1, payload: {} });
    const contentHash = createHash("sha256").update(checkpointJson).digest("hex");
    await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoint_contents", {
      contentHash,
      checkpointJson,
      sizeBytes: Buffer.byteLength(checkpointJson, "utf8"),
      createdAtMs: snapshot.createdAtMs,
    });
    await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoints", {
      runId: "parent-checkpoint-horizon",
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      sequence: 0,
      contentHash,
      codec: "test.fork",
      version: 1,
      agentId: "agent-analyze",
      purpose: "turn",
      createdAtMs: snapshot.createdAtMs,
    });
    const result = await forkRun(adapter, { parentRunId: "parent-checkpoint-horizon", frameNo: 2 });
    expect(await adapter.listAgentCheckpointRefs(result.runId)).toEqual([]);
  });
  test("uses the snapshot timestamp for legacy checkpoint inheritance", async () => {
    const { adapter, sqlite } = createTestDb();
    const runId = "parent-checkpoint-legacy";
    await adapter.insertAttempt({
      runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 100,
      finishedAtMs: 200,
      cached: false,
    });
    const insertCheckpoint = async (sequence, cursor, createdAtMs) => {
      const checkpointJson = JSON.stringify({ codec: "test.fork", version: 1, payload: { cursor } });
      const contentHash = createHash("sha256").update(checkpointJson).digest("hex");
      await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoint_contents", {
        contentHash,
        checkpointJson,
        sizeBytes: Buffer.byteLength(checkpointJson, "utf8"),
        createdAtMs,
      });
      await adapter.internalStorage.insertIgnore("_smithers_agent_checkpoints", {
        runId,
        nodeId: "analyze",
        iteration: 0,
        attempt: 1,
        sequence,
        contentHash,
        codec: "test.fork",
        version: 1,
        agentId: "agent-analyze",
        purpose: "turn",
        createdAtMs,
      });
      return contentHash;
    };
    const retainedHash = await insertCheckpoint(0, "retained", 100);
    const snapshot = await captureSnapshot(adapter, runId, 2, sampleData());
    const legacyOutputs = JSON.parse(snapshot.outputsJson);
    delete legacyOutputs.__smithersAgentCheckpointHorizons;
    delete legacyOutputs.__smithersAgentCheckpointProvenance;
    sqlite
      .query("UPDATE _smithers_snapshot_contents SET outputs_json = ? WHERE content_hash = ?")
      .run(JSON.stringify(legacyOutputs), snapshot.contentHash);
    await insertCheckpoint(1, "future", snapshot.createdAtMs + 1);

    const result = await forkRun(adapter, { parentRunId: runId, frameNo: 2 });

    expect((await adapter.listAgentCheckpointRefs(result.runId)).map((ref) => ref.contentHash)).toEqual([retainedHash]);
  });
  test("does not copy a reused attempt key newer than a legacy snapshot", async () => {
    const { adapter, sqlite } = createTestDb();
    const runId = "parent-attempt-legacy";
    await adapter.insertAttempt({
      runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      state: "finished",
      startedAtMs: 100,
      finishedAtMs: 200,
      cached: false,
      responseText: "snapshot generation",
    });
    const snapshot = await captureSnapshot(adapter, runId, 2, sampleData());
    const legacyOutputs = JSON.parse(snapshot.outputsJson);
    delete legacyOutputs.__smithersAgentCheckpointHorizons;
    delete legacyOutputs.__smithersAgentCheckpointProvenance;
    sqlite
      .query("UPDATE _smithers_snapshot_contents SET outputs_json = ? WHERE content_hash = ?")
      .run(JSON.stringify(legacyOutputs), snapshot.contentHash);
    await adapter.internalStorage.deleteWhere(
      "_smithers_attempts",
      "run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?",
      [runId, "analyze", 0, 1],
    );
    await adapter.insertAttempt({
      runId,
      nodeId: "analyze",
      iteration: 0,
      attempt: 1,
      state: "failed",
      startedAtMs: snapshot.createdAtMs + 1,
      finishedAtMs: snapshot.createdAtMs + 2,
      cached: false,
      responseText: "replacement generation",
    });

    const result = await forkRun(adapter, { parentRunId: runId, frameNo: 2 });
    expect(await adapter.listAttemptsForRun(result.runId)).toEqual([]);
  });
  test("fails closed on malformed present provenance before creating a child", async () => {
    const { adapter, sqlite } = createTestDb();
    const snapshot = await captureSnapshot(adapter, "parent-malformed-checkpoint", 2, sampleData());
    const outputs = JSON.parse(snapshot.outputsJson);
    outputs.__smithersAgentCheckpointProvenance = { version: 1, attempts: [], checkpoints: "corrupt" };
    sqlite
      .query("UPDATE _smithers_snapshot_contents SET outputs_json = ? WHERE content_hash = ?")
      .run(JSON.stringify(outputs), snapshot.contentHash);

    await expect(forkRun(adapter, { parentRunId: "parent-malformed-checkpoint", frameNo: 2 })).rejects.toThrow(
      /provenance envelope is corrupt/,
    );
    expect(await listBranches(adapter, "parent-malformed-checkpoint")).toEqual([]);
  });
  test("records branch label and description", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-run", 0, sampleData());
    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 0,
      branchLabel: "experiment-1",
      forkDescription: "Testing new approach",
    });
    expect(result.branch.branchLabel).toBe("experiment-1");
    expect(result.branch.forkDescription).toBe("Testing new approach");
  });
  test("copies parent run metadata when the source run exists", async () => {
    const { adapter } = createTestDb();
    await adapter.insertRun({
      runId: "parent-run",
      parentRunId: null,
      workflowName: "time-travel-parent",
      workflowPath: "/tmp/workflow.tsx",
      workflowHash: "workflow-hash",
      status: "finished",
      createdAtMs: 1_000,
      startedAtMs: 1_100,
      finishedAtMs: 1_200,
      heartbeatAtMs: 1_150,
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
      hijackRequestedAtMs: null,
      hijackTarget: null,
      vcsType: "jj",
      vcsRoot: "/tmp",
      vcsRevision: "abc123",
      errorJson: null,
      configJson: '{"__smithersDurability":{"version":2,"entryWorkflowHash":"entry-hash"}}',
    });
    await captureSnapshot(
      adapter,
      "parent-run",
      0,
      sampleData({ workflowHash: "workflow-hash", vcsPointer: "abc123" }),
    );
    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 0,
    });
    const childRun = await adapter.getRun(result.runId);
    expect(childRun).toBeDefined();
    expect(childRun).toMatchObject({
      runId: result.runId,
      parentRunId: "parent-run",
      workflowName: "time-travel-parent",
      workflowPath: "/tmp/workflow.tsx",
      workflowHash: "workflow-hash",
      status: "finished",
      vcsType: "jj",
      vcsRoot: "/tmp",
      vcsRevision: "abc123",
      configJson: '{"__smithersDurability":{"version":2,"entryWorkflowHash":"entry-hash"}}',
    });
    expect(childRun?.runtimeOwnerId).toBeNull();
    expect(childRun?.heartbeatAtMs).toBeNull();
  });
  test("can override workflow hashes so forked children resume current source", async () => {
    const { adapter } = createTestDb();
    await adapter.insertRun({
      runId: "parent-run",
      parentRunId: null,
      workflowName: "time-travel-parent",
      workflowPath: "/tmp/old-workflow.tsx",
      workflowHash: "old-workflow-hash",
      status: "failed",
      createdAtMs: 1_000,
      startedAtMs: 1_100,
      finishedAtMs: 1_200,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
      hijackRequestedAtMs: null,
      hijackTarget: null,
      vcsType: null,
      vcsRoot: null,
      vcsRevision: null,
      errorJson: null,
      configJson: JSON.stringify({
        keep: "value",
        __smithersDurability: {
          version: 2,
          entryWorkflowHash: "old-entry-hash",
        },
      }),
    });
    await captureSnapshot(
      adapter,
      "parent-run",
      0,
      sampleData({
        workflowHash: "old-workflow-hash",
      }),
    );

    const result = await forkRun(adapter, {
      parentRunId: "parent-run",
      frameNo: 0,
      workflowPath: "/tmp/new-workflow.tsx",
      workflowHash: "new-workflow-hash",
      entryWorkflowHash: "new-entry-hash",
    });

    const childRun = await adapter.getRun(result.runId);
    expect(childRun).toMatchObject({
      workflowPath: "/tmp/new-workflow.tsx",
      workflowHash: "new-workflow-hash",
    });
    expect(JSON.parse(childRun?.configJson ?? "{}")).toEqual({
      keep: "value",
      __smithersDurability: {
        version: 2,
        entryWorkflowHash: "new-entry-hash",
      },
    });
    expect(result.snapshot.workflowHash).toBe("new-workflow-hash");
  });
  test("fails for non-existent snapshot", async () => {
    const { adapter } = createTestDb();
    await expect(forkRun(adapter, { parentRunId: "nonexistent", frameNo: 0 })).rejects.toThrow("No snapshot found");
  });
  test("serializes fork with a contender holding the durable rewind lease", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent-lock-race", 0, sampleData());
    const rewindLock = await acquireRewindLock(adapter, "parent-lock-race");
    expect(rewindLock).not.toBeNull();

    await expect(forkRun(adapter, { parentRunId: "parent-lock-race", frameNo: 0 })).rejects.toThrow(
      /Another rewind or fork is already running/,
    );
    expect(await loadSnapshot(adapter, "parent-lock-race", 0)).toBeDefined();
    expect(await listBranches(adapter, "parent-lock-race")).toEqual([]);

    await rewindLock.release();
    const fork = await forkRun(adapter, { parentRunId: "parent-lock-race", frameNo: 0 });
    expect(fork.branch.parentRunId).toBe("parent-lock-race");
  });
  test("refuses fork --run from a live parent unless forced", async () => {
    const { adapter } = createTestDb();
    const parentRunId = "live-fork-parent";
    await adapter.insertRun({
      runId: parentRunId,
      workflowName: "live-parent",
      status: "running",
      createdAtMs: Date.now() - 1_000,
      startedAtMs: Date.now() - 900,
      heartbeatAtMs: Date.now(),
      runtimeOwnerId: null,
    });
    await captureSnapshot(adapter, parentRunId, 0, sampleData());

    await expect(
      forkRun(adapter, {
        parentRunId,
        frameNo: 0,
        autoRun: true,
        operation: "fork",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("still running"),
    });
    expect(await listBranches(adapter, parentRunId)).toEqual([]);
  });
  test("rolls back the child when an effect appears after the pre-check", async () => {
    const { adapter, sqlite } = createTestDb();
    const parentRunId = "fork-raced-effect-parent";
    await adapter.insertRun({
      runId: parentRunId,
      workflowName: "raced-parent",
      status: "finished",
      createdAtMs: 1,
      startedAtMs: 2,
      finishedAtMs: 3,
    });
    const source = await captureSnapshot(adapter, parentRunId, 0, sampleData());
    const originalInsertRun = adapter.insertRun.bind(adapter);
    let injected = false;
    adapter.insertRun = (row) =>
      originalInsertRun(row).pipe(
        Effect.tap(() => {
          if (injected || row.parentRunId !== parentRunId) return Effect.void;
          injected = true;
          return adapter.insertToolCall({
            runId: parentRunId,
            nodeId: "publish",
            iteration: 0,
            attempt: 1,
            seq: 1,
            toolName: "raced-publish",
            inputJson: "{}",
            outputJson: "{}",
            startedAtMs: source.createdAtMs + 1,
            finishedAtMs: source.createdAtMs + 2,
            status: "succeeded",
            errorJson: null,
            kind: "tool",
            sideEffect: true,
            idempotent: false,
            acceptsIdempotencyKey: false,
            hasRevert: false,
            idempotencyKey: null,
            revertStatus: null,
            revertedAtMs: null,
            revertErrorJson: null,
            forcedPastJson: null,
          });
        }),
      );
    try {
      await expect(
        forkRun(adapter, {
          parentRunId,
          frameNo: 0,
          autoRun: true,
          operation: "replay",
        }),
      ).rejects.toMatchObject({
        code: "TIME_TRAVEL_SIDE_EFFECT_BLOCKED",
        details: {
          report: {
            blocking: [
              {
                toolName: "raced-publish",
                effectStatus: "succeeded",
              },
            ],
          },
        },
      });
    } finally {
      adapter.insertRun = originalInsertRun;
    }

    expect(injected).toBe(true);
    expect(await listBranches(adapter, parentRunId)).toEqual([]);
    expect(sqlite.query(`SELECT run_id FROM _smithers_snapshots WHERE run_id != ?`).all(parentRunId)).toEqual([]);
  });
  test("rolls back the child when the parent is reclaimed during child insertion", async () => {
    const { adapter, sqlite } = createTestDb();
    const parentRunId = "fork-parent-reclaimed-during-persist";
    await adapter.insertRun({
      runId: parentRunId,
      workflowName: "reclaimed-parent",
      status: "finished",
      createdAtMs: 1,
      startedAtMs: 2,
      finishedAtMs: 3,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
    });
    await captureSnapshot(adapter, parentRunId, 0, sampleData());
    const originalInsertRun = adapter.insertRun.bind(adapter);
    let reclaimed = false;
    adapter.insertRun = (row) =>
      originalInsertRun(row).pipe(
        Effect.tap(() => {
          if (reclaimed || row.parentRunId !== parentRunId) return Effect.void;
          reclaimed = true;
          return adapter.updateRun(parentRunId, {
            status: "running",
            finishedAtMs: null,
            heartbeatAtMs: Date.now(),
            runtimeOwnerId: "replacement-owner",
          });
        }),
      );
    try {
      await expect(
        forkRun(adapter, {
          parentRunId,
          frameNo: 0,
          autoRun: true,
          operation: "fork",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining("still running"),
      });
    } finally {
      adapter.insertRun = originalInsertRun;
    }

    expect(reclaimed).toBe(true);
    expect(await listBranches(adapter, parentRunId)).toEqual([]);
    expect(sqlite.query(`SELECT run_id FROM _smithers_snapshots WHERE run_id != ?`).all(parentRunId)).toEqual([]);
  });
});
describe("listBranches", () => {
  test("returns empty array when no branches exist", async () => {
    const { adapter } = createTestDb();
    const branches = await listBranches(adapter, "nonexistent");
    expect(branches).toEqual([]);
  });
  test("lists child branches for a parent run", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent", 0, sampleData());
    await captureSnapshot(adapter, "parent", 1, sampleData());
    await forkRun(adapter, {
      parentRunId: "parent",
      frameNo: 0,
      branchLabel: "fork-1",
    });
    await forkRun(adapter, {
      parentRunId: "parent",
      frameNo: 1,
      branchLabel: "fork-2",
    });
    const branches = await listBranches(adapter, "parent");
    expect(branches.length).toBe(2);
    expect(branches.map((b) => b.branchLabel).sort()).toEqual(["fork-1", "fork-2"]);
  });
});
describe("getBranchInfo", () => {
  test("returns undefined for non-forked run", async () => {
    const { adapter } = createTestDb();
    const info = await getBranchInfo(adapter, "regular-run");
    expect(info).toBeUndefined();
  });
  test("returns branch info for a forked run", async () => {
    const { adapter } = createTestDb();
    await captureSnapshot(adapter, "parent", 2, sampleData());
    const result = await forkRun(adapter, {
      parentRunId: "parent",
      frameNo: 2,
      branchLabel: "my-fork",
    });
    const info = await getBranchInfo(adapter, result.runId);
    expect(info).toBeDefined();
    expect(info.parentRunId).toBe("parent");
    expect(info.parentFrameNo).toBe(2);
    expect(info.branchLabel).toBe("my-fork");
  });
});
