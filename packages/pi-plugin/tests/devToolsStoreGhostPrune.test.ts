import { describe, expect, test } from "bun:test";
import { DevToolsStore } from "../src/runtime/DevToolsStore.js";
import type { DevToolsDelta, DevToolsNode, DevToolsSnapshot } from "@smthrs/protocol";

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
    runId: "run-prune",
    frameNo: seq,
    seq,
    root: { id: 1, type: "workflow", name: "Workflow", props: { state: "running" }, children, depth: 0 },
  };
}

describe("DevToolsStore ghost pruning when a removed node reappears", () => {
  test("a ghost whose node is re-added by a later snapshot is pruned back out", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
    // Mount task:gone, then a delta drops it -> it is retained as a ghost.
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(1, [task(2, "task:gone", "running")]) });
    const delta: DevToolsDelta = {
      version: 1,
      baseSeq: 1,
      seq: 2,
      ops: [
        {
          op: "replaceRoot",
          node: {
            id: 1,
            type: "workflow",
            name: "Workflow",
            props: { state: "running" },
            children: [task(3, "task:new", "running")],
            depth: 0,
          },
        },
      ],
    } as DevToolsDelta;
    store.applyEvent({ version: 1, kind: "delta", delta });
    expect(store.ghostNodes.has("task:gone")).toBe(true);

    // A newer snapshot re-adds task:gone. pruneGhostNodesNowActive iterates the
    // non-empty ghost set and its predicate matches the now-active key, evicting
    // the ghost.
    store.applyEvent({
      version: 1,
      kind: "snapshot",
      snapshot: snapshot(3, [task(2, "task:gone", "running"), task(3, "task:new", "running")]),
    });
    expect(store.ghostNodes.has("task:gone")).toBe(false);
  });
});
