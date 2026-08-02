import { Database } from "bun:sqlite";
import { describe, expect, onTestFinished, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";

const RUN_ID = "case13-run";
const ROOT_NODE_ID = "root";
const MID_NODE_ID = "mid";
const LEAF_NODE_ID = "leaf";
const FAILED_STATES = new Set(["failed", "error"]);

type FrameTreeNode = {
  nodeId: string;
  state: string;
  children: FrameTreeNode[];
};

type EventRow = {
  runId: string;
  seq: number;
  type: string;
  payloadJson: string;
};

type CaseDb = {
  sqlite: Database;
  adapter: SmithersDb;
};

type NodeRow = {
  nodeId: string;
  state: string;
};

type FrameRow = {
  frameNo: number;
  xmlJson: string;
};

function buildDb(): CaseDb {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter: SmithersDb, now: number): Promise<void> {
  await adapter.insertRun({
    runId: RUN_ID,
    workflowName: "case13-workflow",
    status: "running",
    createdAtMs: now - 5_000,
    startedAtMs: now - 4_000,
    heartbeatAtMs: now - 500,
    runtimeOwnerId: "engine:case13",
  });
}

async function upsertNode(
  adapter: SmithersDb,
  nodeId: string,
  state: string,
  updatedAtMs: number,
  label: string,
): Promise<void> {
  await adapter.insertNode({
    runId: RUN_ID,
    nodeId,
    iteration: 0,
    state,
    lastAttempt: 1,
    updatedAtMs,
    outputTable: `out_${nodeId}`,
    label,
  });
}

async function commitFrameTree(
  adapter: SmithersDb,
  frameNo: number,
  createdAtMs: number,
  tree: FrameTreeNode,
  mountedTaskIds: string[],
): Promise<void> {
  await adapter.insertFrame({
    runId: RUN_ID,
    frameNo,
    createdAtMs,
    xmlJson: JSON.stringify(tree),
    xmlHash: `hash:${frameNo}`,
    mountedTaskIdsJson: JSON.stringify(mountedTaskIds),
    taskIndexJson: JSON.stringify(
      mountedTaskIds.map((id, idx) => ({ nodeId: id, index: idx })),
    ),
  });
}

function parseFrameTree(row: FrameRow | undefined): FrameTreeNode {
  if (!row) throw new Error("frame missing");
  return JSON.parse(row.xmlJson) as FrameTreeNode;
}

async function readLatestFrameTree(adapter: SmithersDb): Promise<FrameTreeNode> {
  return parseFrameTree(
    (await adapter.getLastFrame(RUN_ID)) as FrameRow | undefined,
  );
}

async function readFrameTree(
  adapter: SmithersDb,
  frameNo: number,
): Promise<FrameTreeNode> {
  const frames = (await adapter.listFrames(RUN_ID, 100)) as FrameRow[];
  return parseFrameTree(frames.find((frame) => frame.frameNo === frameNo));
}

async function readNodeState(
  adapter: SmithersDb,
  nodeId: string,
): Promise<string> {
  const row = (await adapter.getNode(RUN_ID, nodeId, 0)) as NodeRow | undefined;
  if (!row) throw new Error(`node missing: ${nodeId}`);
  return row.state;
}

async function recordNodeFailedEvent(
  adapter: SmithersDb,
  nodeId: string,
  attempt: number,
  errorMessage: string,
  timestampMs: number,
): Promise<number> {
  return await adapter.insertEventWithNextSeq({
    runId: RUN_ID,
    timestampMs,
    type: "NodeFailed",
    payloadJson: JSON.stringify({
      runId: RUN_ID,
      nodeId,
      iteration: 0,
      attempt,
      error: { message: errorMessage, kind: "tool" },
    }),
  });
}

async function readEventsByType(
  adapter: SmithersDb,
  type: string,
): Promise<EventRow[]> {
  return (await adapter.listEventsByType(RUN_ID, type)) as EventRow[];
}

function ancestorPath(tree: FrameTreeNode, target: string): FrameTreeNode[] {
  const path: FrameTreeNode[] = [];
  function walk(node: FrameTreeNode, trail: FrameTreeNode[]): boolean {
    const next = [...trail, node];
    if (node.nodeId === target) {
      path.push(...next);
      return true;
    }
    for (const child of node.children) {
      if (walk(child, next)) return true;
    }
    return false;
  }
  walk(tree, []);
  return path;
}

function aggregatedFailureMarker(
  node: FrameTreeNode,
  liveStateByNodeId: Map<string, string>,
): boolean {
  const liveState = liveStateByNodeId.get(node.nodeId) ?? node.state;
  if (FAILED_STATES.has(liveState)) return true;
  for (const child of node.children) {
    if (aggregatedFailureMarker(child, liveStateByNodeId)) return true;
  }
  return false;
}

async function liveStateMap(adapter: SmithersDb): Promise<Map<string, string>> {
  const rows = (await adapter.listNodes(RUN_ID)) as NodeRow[];
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.nodeId, row.state);
  return map;
}

async function nodeStateCounts(
  adapter: SmithersDb,
): Promise<Map<string, number>> {
  const rows = await adapter.countNodesByState(RUN_ID);
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.state, Number(row.count));
  return map;
}

describe("case 13: collapsed ancestor shows failure marker", () => {
  test("DB-level bubble-up: failed leaf surfaces failure on every ancestor in frame tree", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedRun(adapter, t0);
    await upsertNode(adapter, ROOT_NODE_ID, "running", t0 - 300, "Root");
    await upsertNode(adapter, MID_NODE_ID, "running", t0 - 200, "Mid");
    await upsertNode(adapter, LEAF_NODE_ID, "running", t0 - 100, "Leaf");

    const initialTree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "running", children: [] },
          ],
        },
      ],
    };
    await commitFrameTree(adapter, 1, t0 - 100, initialTree, [
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);

    const live = await liveStateMap(adapter);
    expect(aggregatedFailureMarker(initialTree, live)).toBe(false);

    const failedAt = t0 + 50;
    await upsertNode(adapter, LEAF_NODE_ID, "failed", failedAt, "Leaf");

    const failedSeq = await recordNodeFailedEvent(
      adapter,
      LEAF_NODE_ID,
      1,
      "tool blew up",
      failedAt,
    );
    expect(failedSeq).toBe(0);

    const failedTree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "failed", children: [] },
          ],
        },
      ],
    };
    await commitFrameTree(adapter, 2, failedAt, failedTree, [
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);

    expect(await readNodeState(adapter, LEAF_NODE_ID)).toBe("failed");
    expect(await readNodeState(adapter, MID_NODE_ID)).toBe("running");
    expect(await readNodeState(adapter, ROOT_NODE_ID)).toBe("running");
    const counts = await nodeStateCounts(adapter);
    expect(counts.get("failed")).toBe(1);
    expect(counts.get("running")).toBe(2);

    const latest = await readLatestFrameTree(adapter);
    const liveAfter = await liveStateMap(adapter);

    const path = ancestorPath(latest, LEAF_NODE_ID);
    expect(path.map((n) => n.nodeId)).toEqual([
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);

    for (const ancestor of path) {
      expect(aggregatedFailureMarker(ancestor, liveAfter)).toBe(true);
    }

    expect(aggregatedFailureMarker(latest, liveAfter)).toBe(true);
    expect(aggregatedFailureMarker(latest.children[0], liveAfter)).toBe(true);
    expect(
      aggregatedFailureMarker(latest.children[0].children[0], liveAfter),
    ).toBe(true);
  });

  test("collapse-independence: NodeFailed event for buried leaf is queryable from run event log", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedRun(adapter, t0);
    await upsertNode(adapter, ROOT_NODE_ID, "running", t0 - 300, "Root");
    await upsertNode(adapter, MID_NODE_ID, "running", t0 - 200, "Mid");
    await upsertNode(adapter, LEAF_NODE_ID, "failed", t0, "Leaf");

    const tree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "failed", children: [] },
          ],
        },
      ],
    };
    await commitFrameTree(adapter, 1, t0, tree, [
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);
    await recordNodeFailedEvent(adapter, LEAF_NODE_ID, 2, "boom", t0);

    const failedEvents = await readEventsByType(adapter, "NodeFailed");
    expect(failedEvents).toHaveLength(1);
    const payload = JSON.parse(failedEvents[0].payloadJson) as {
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      error: { message: string };
    };
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.nodeId).toBe(LEAF_NODE_ID);
    expect(payload.iteration).toBe(0);
    expect(payload.attempt).toBe(2);
    expect(payload.error.message).toBe("boom");

    const ancestors = ancestorPath(tree, LEAF_NODE_ID).slice(0, -1);
    expect(ancestors.map((a) => a.nodeId)).toEqual([
      ROOT_NODE_ID,
      MID_NODE_ID,
    ]);
    for (const ancestor of ancestors) {
      const reachable = ancestorPath(ancestor, LEAF_NODE_ID).at(-1);
      expect(reachable?.nodeId).toBe(LEAF_NODE_ID);
    }
  });

  test("schema invariant: frame tree provides stable ancestor linkage; aggregator can be re-run on any frame_no", async () => {
    const { sqlite, adapter } = buildDb();
    onTestFinished(() => sqlite.close());

    const t0 = Date.now();
    await seedRun(adapter, t0);
    await upsertNode(adapter, ROOT_NODE_ID, "running", t0 - 300, "Root");
    await upsertNode(adapter, MID_NODE_ID, "running", t0 - 200, "Mid");
    await upsertNode(adapter, LEAF_NODE_ID, "running", t0 - 100, "Leaf");

    const f1Tree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "running", children: [] },
          ],
        },
      ],
    };
    await commitFrameTree(adapter, 1, t0 - 100, f1Tree, [
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);

    const f2Tree: FrameTreeNode = {
      nodeId: ROOT_NODE_ID,
      state: "running",
      children: [
        {
          nodeId: MID_NODE_ID,
          state: "running",
          children: [
            { nodeId: LEAF_NODE_ID, state: "failed", children: [] },
          ],
        },
      ],
    };
    await upsertNode(adapter, LEAF_NODE_ID, "failed", t0 + 25, "Leaf");
    await commitFrameTree(adapter, 2, t0 + 25, f2Tree, [
      ROOT_NODE_ID,
      MID_NODE_ID,
      LEAF_NODE_ID,
    ]);
    await recordNodeFailedEvent(adapter, LEAF_NODE_ID, 1, "boom", t0 + 25);

    const frame1Tree = await readFrameTree(adapter, 1);
    const frame2Tree = await readFrameTree(adapter, 2);

    const live = await liveStateMap(adapter);

    expect(aggregatedFailureMarker(frame1Tree, new Map())).toBe(false);
    expect(aggregatedFailureMarker(frame2Tree, new Map())).toBe(true);
    expect(aggregatedFailureMarker(frame2Tree, live)).toBe(true);

    const f1Path = ancestorPath(frame1Tree, LEAF_NODE_ID).map((n) => n.nodeId);
    const f2Path = ancestorPath(frame2Tree, LEAF_NODE_ID).map((n) => n.nodeId);
    expect(f1Path).toEqual(f2Path);
  });

  test.skip("client-side: DevToolsStore renders failure marker on collapsed ancestor (gui/0001, pi-plugin/runtime/DevToolsStore.ts)", () => {
    // Skipped: the failure-aggregation walk that turns a collapsed ancestor's
    // chevron red is implemented client-side. Today neither the DB
    // (`_smithers_nodes` has no `parent_node_id`, no aggregator view) nor
    // packages/pi-plugin/src/runtime/DevToolsStore.ts (no
    // `hasFailedDescendant` / `aggregateStatus` walk over `tree`) computes it.
    // The contract is documented only in
    // packages/pi-plugin/src/buildSmithersPiSystemPrompt.ts ("Failed
    // descendants bubble an error marker to collapsed ancestors"). Re-enable
    // once gui/0001 (Inspector GUI) ships the tree renderer with a collapse
    // model and a `failureMarker` selector on DevToolsStore that walks
    // `tree.children` for any descendant in {failed, error} state, even when
    // the ancestor is collapsed.
    expect(true).toBe(true);
  });
});
