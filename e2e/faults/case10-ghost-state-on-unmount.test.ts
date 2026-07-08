import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";

const RUN_ID = "case10-run";
const SELECTED_NODE_ID = "n2";
const SELECTED_ITERATION = 0;

type NodeSnapshot = {
  runId: string;
  nodeId: string;
  iteration: number;
  state: string;
  updatedAtMs: number;
  outputTable: string;
  label: string | null;
};

type EventRow = {
  runId: string;
  seq: number;
  type: string;
  payloadJson: string;
};

function buildDb(): { sqlite: Database; adapter: SmithersDb } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter: SmithersDb, now: number): Promise<void> {
  await adapter.insertRun({
    runId: RUN_ID,
    workflowName: "case10-workflow",
    status: "running",
    createdAtMs: now - 5_000,
    startedAtMs: now - 4_000,
    heartbeatAtMs: now - 500,
    runtimeOwnerId: "engine:case10",
  });
}

async function seedNode(
  adapter: SmithersDb,
  nodeId: string,
  state: string,
  updatedAtMs: number,
  label: string | null,
): Promise<void> {
  await adapter.insertNode({
    runId: RUN_ID,
    nodeId,
    iteration: SELECTED_ITERATION,
    state,
    lastAttempt: 1,
    updatedAtMs,
    outputTable: `out_${nodeId}`,
    label,
  });
}

async function seedGraph(adapter: SmithersDb, now: number): Promise<void> {
  await seedRun(adapter, now);
  await seedNode(adapter, "n1", "running", now - 200, "Plan");
  await seedNode(adapter, "n2", "running", now - 100, "Build");
  await seedNode(adapter, "n3", "waiting-approval", now - 50, "Approve");
}

async function readNode(
  adapter: SmithersDb,
  nodeId: string,
): Promise<NodeSnapshot | null> {
  return (
    ((await adapter.getNode(
      RUN_ID,
      nodeId,
      SELECTED_ITERATION,
    )) as NodeSnapshot | undefined) ?? null
  );
}

async function readNodeIds(adapter: SmithersDb): Promise<string[]> {
  const rows = await adapter.listNodes(RUN_ID);
  return rows.map((row) => String(row.nodeId)).sort();
}

async function recordUnmountEvent(
  adapter: SmithersDb,
  nodeId: string,
  lastSnapshot: NodeSnapshot,
  timestampMs: number,
): Promise<number> {
  return await adapter.insertEventWithNextSeq({
    runId: RUN_ID,
    timestampMs,
    type: "NodeUnmounted",
    payloadJson: JSON.stringify({
      runId: RUN_ID,
      nodeId,
      iteration: lastSnapshot.iteration,
      lastSeen: {
        state: lastSnapshot.state,
        updatedAtMs: lastSnapshot.updatedAtMs,
        outputTable: lastSnapshot.outputTable,
        label: lastSnapshot.label,
      },
    }),
  });
}

async function readEventsForNode(
  adapter: SmithersDb,
  nodeId: string,
): Promise<EventRow[]> {
  return (await adapter.listEventHistory(RUN_ID, {
    nodeId,
    limit: 100,
  })) as EventRow[];
}

describe("case 10: node unmount after selection; ghost state preserved", () => {
  test("DB-level ghost contract: node row survives unmount and inspector sees last-known state", async () => {
    const { sqlite, adapter } = buildDb();

    try {
      const t0 = Date.now();
      await seedGraph(adapter, t0);

      const beforeIds = await readNodeIds(adapter);
      expect(beforeIds).toEqual(["n1", "n2", "n3"]);

      const inspectorSnapshot = await readNode(adapter, SELECTED_NODE_ID);
      expect(inspectorSnapshot).not.toBeNull();
      if (!inspectorSnapshot) return;
      expect(inspectorSnapshot.state).toBe("running");
      expect(inspectorSnapshot.label).toBe("Build");
      expect(inspectorSnapshot.outputTable).toBe("out_n2");

      const unmountTs = t0 + 50;
      const unmountSeq = await recordUnmountEvent(
        adapter,
        SELECTED_NODE_ID,
        inspectorSnapshot,
        unmountTs,
      );
      expect(unmountSeq).toBe(0);

      const afterIds = await readNodeIds(adapter);
      expect(afterIds).toEqual(["n1", "n2", "n3"]);

      const ghost = await readNode(adapter, SELECTED_NODE_ID);
      expect(ghost).not.toBeNull();
      if (!ghost) return;
      expect(ghost.nodeId).toBe(SELECTED_NODE_ID);
      expect(ghost.state).toBe(inspectorSnapshot.state);
      expect(ghost.updatedAtMs).toBe(inspectorSnapshot.updatedAtMs);
      expect(ghost.outputTable).toBe(inspectorSnapshot.outputTable);
      expect(ghost.label).toBe(inspectorSnapshot.label);

      const events = await readEventsForNode(adapter, SELECTED_NODE_ID);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("NodeUnmounted");
      const payload = JSON.parse(events[0].payloadJson) as {
        nodeId: string;
        iteration: number;
        lastSeen: {
          state: string;
          updatedAtMs: number;
          outputTable: string;
          label: string | null;
        };
      };
      expect(payload.nodeId).toBe(SELECTED_NODE_ID);
      expect(payload.iteration).toBe(SELECTED_ITERATION);
      expect(payload.lastSeen.state).toBe(inspectorSnapshot.state);
      expect(payload.lastSeen.updatedAtMs).toBe(inspectorSnapshot.updatedAtMs);
      expect(payload.lastSeen.outputTable).toBe(inspectorSnapshot.outputTable);
      expect(payload.lastSeen.label).toBe(inspectorSnapshot.label);
    } finally {
      sqlite.close();
    }
  });

  test("ghost rows do not move forward after the live engine advances peers", async () => {
    const { sqlite, adapter } = buildDb();

    try {
      const t0 = Date.now();
      await seedGraph(adapter, t0);

      const captured = await readNode(adapter, SELECTED_NODE_ID);
      expect(captured).not.toBeNull();
      if (!captured) return;

      await recordUnmountEvent(adapter, SELECTED_NODE_ID, captured, t0 + 10);

      await seedNode(adapter, "n1", "finished", t0 + 100, "Plan");
      await seedNode(adapter, "n3", "running", t0 + 100, "Approve");

      const stateCounts = await adapter.countNodesByState(RUN_ID);
      expect(
        Object.fromEntries(
          stateCounts.map((row) => [row.state, Number(row.count)]),
        ),
      ).toEqual({ finished: 1, running: 2 });

      const ghost = await readNode(adapter, SELECTED_NODE_ID);
      expect(ghost).not.toBeNull();
      if (!ghost) return;
      expect(ghost.state).toBe(captured.state);
      expect(ghost.updatedAtMs).toBe(captured.updatedAtMs);
      expect(ghost.label).toBe(captured.label);
    } finally {
      sqlite.close();
    }
  });

  test("audit trail: NodeUnmounted event stays queryable without a current node row", async () => {
    const { sqlite, adapter } = buildDb();

    try {
      const t0 = Date.now();
      await seedRun(adapter, t0);
      const captured: NodeSnapshot = {
        runId: RUN_ID,
        nodeId: SELECTED_NODE_ID,
        iteration: SELECTED_ITERATION,
        state: "running",
        updatedAtMs: t0 - 100,
        outputTable: "out_n2",
        label: "Build",
      };

      await recordUnmountEvent(adapter, SELECTED_NODE_ID, captured, t0 + 25);

      expect(await readNode(adapter, SELECTED_NODE_ID)).toBeNull();

      const events = await readEventsForNode(adapter, SELECTED_NODE_ID);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("NodeUnmounted");
      const payload = JSON.parse(events[0].payloadJson) as {
        lastSeen: { state: string; updatedAtMs: number };
      };
      expect(payload.lastSeen.state).toBe(captured.state);
      expect(payload.lastSeen.updatedAtMs).toBe(captured.updatedAtMs);
    } finally {
      sqlite.close();
    }
  });

  test.skip("client-side: DevToolsStore.ghostNodes preserves selected node after live tree drops it (gui/0001, pi-plugin/runtime/DevToolsStore.ts)", () => {
    // Skipped: ghost-state preservation is implemented client-side in
    // packages/pi-plugin/src/runtime/DevToolsStore.ts (`ghostNodes` Map,
    // `unmountedFrameNo`/`unmountedSeq`, `selectedGhostRecord`). The schema
    // has no `lastSeen`/`unmounted_at_ms` column on `_smithers_nodes` — the
    // ghost is held in client memory while the row + audit event stay in the
    // DB. Re-enable once gui/0001 (Inspector GUI) ships an integration
    // harness that drives the store from a recorded delta stream and asserts
    // the inspector pane retains last-known props after the unmount delta is
    // applied.
    expect(true).toBe(true);
  });
});
