import { describe, expect, test } from "bun:test";
import { DevToolsStore } from "../src/runtime/DevToolsStore.js";
import type { DevToolsClient } from "../src/runtime/DevToolsClient.js";
import type { DevToolsNode, DevToolsSnapshot } from "@smithers-orchestrator/protocol";

function task(id: number, nodeId: string, state: string): DevToolsNode {
  return {
    id,
    type: "task",
    name: nodeId,
    props: { state },
    task: { nodeId, kind: "compute", label: nodeId, iteration: 0 },
    children: [],
    depth: 1,
  };
}

function snapshot(seq: number, children: DevToolsNode[]): DevToolsSnapshot {
  return {
    version: 1,
    runId: "run-edge",
    frameNo: seq,
    seq,
    root: { id: 1, type: "workflow", name: "Workflow", props: { state: "running" }, children, depth: 0 },
  };
}

function fakeClient(overrides: Partial<DevToolsClient>): DevToolsClient {
  return overrides as DevToolsClient;
}

describe("DevToolsStore edge accessors and branches", () => {
  test("heartbeatAgeMs computes once an event lands; ghost lookups honor keyless nodes", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(1, [task(2, "task:a", "running")]) });
    // lastEventAt is set now -> the compute branch of heartbeatAgeMs runs.
    expect(store.heartbeatAgeMs).toBeGreaterThanOrEqual(0);
    expect(store.heartbeatAgeMs).toBeLessThan(Number.MAX_SAFE_INTEGER);

    const active = store.tree!.children[0];
    expect(store.isGhostNode(active)).toBe(false);
    expect(store.ghostRecord(active)).toBeUndefined();

    // A node carrying no nodeId has no ghost key -> the keyless short-circuits.
    const keyless: DevToolsNode = {
      id: 99,
      type: "task",
      name: "keyless",
      props: { state: "running" },
      task: { nodeId: "", kind: "compute", label: "keyless", iteration: 0 },
      children: [],
      depth: 1,
    };
    expect(store.isGhostNode(keyless)).toBe(false);
    expect(store.ghostRecord(keyless)).toBeUndefined();
  });

  test("returnToLive is a no-op while already live", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(1, [task(2, "task:a", "running")]) });
    expect(store.mode.kind).toBe("live");
    store.returnToLive();
    expect(store.mode.kind).toBe("live");
  });

  test("scrubTo without a runId records a missing-run error", async () => {
    const store = new DevToolsStore({ client: fakeClient({}) });
    await store.scrubTo(2);
    expect(store.scrubError).toMatchObject({ code: "PI_RUN_NOT_FOUND" });
  });

  test("selecting a keyless node falls back to an id-based selection key", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
    store.applyEvent({
      version: 1,
      kind: "snapshot",
      snapshot: {
        version: 1,
        runId: "run-edge",
        frameNo: 1,
        seq: 1,
        root: {
          id: 1,
          type: "workflow",
          name: "Workflow",
          props: { state: "running" },
          children: [
            { id: 2, type: "task", name: "keyless", props: { state: "running" }, task: { nodeId: "", kind: "compute", label: "keyless", iteration: 0 }, children: [], depth: 1 },
          ],
          depth: 0,
        },
      },
    });
    store.selectNode(2);
    expect(store.selectedNode?.id).toBe(2);
  });
});
