import { describe, expect, test } from "bun:test";
import { diffSnapshots } from "@smithers-orchestrator/devtools";
import { DevToolsStore } from "../src/runtime/DevToolsStore.js";
import type { DevToolsClient } from "../src/runtime/DevToolsClient.js";
import type { DevToolsNode, DevToolsSnapshot } from "@smithers-orchestrator/protocol";

function task(id: number, nodeId: string, state: string, props: Record<string, unknown> = {}): DevToolsNode {
  return {
    id,
    type: "task",
    name: nodeId,
    props: { state, ...props },
    task: { nodeId, kind: "compute", label: nodeId, iteration: 0 },
    children: [],
    depth: 1,
  };
}

function snapshot(seq: number, children: DevToolsNode[], runId = "run-store"): DevToolsSnapshot {
  return {
    version: 1,
    runId,
    frameNo: seq,
    seq,
    root: {
      id: 1,
      type: "workflow",
      name: "Workflow",
      props: { state: children.some((child) => child.props.state === "running") ? "running" : "finished" },
      children,
      depth: 0,
    },
  };
}

function fakeClient(overrides: Partial<DevToolsClient>): DevToolsClient {
  return overrides as DevToolsClient;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for predicate");
}

describe("DevToolsStore historical controls", () => {
  test("scrubTo loads a historical frame, buffers live updates, and returnToLive restores the live tree", async () => {
    const live = snapshot(5, [task(2, "task:live", "running")]);
    const historical = snapshot(2, [task(3, "task:past", "finished")]);
    const resyncs: Array<number | undefined> = [];
    const store = new DevToolsStore({
      client: fakeClient({
        getDevToolsSnapshot: async (_runId, frameNo) => (frameNo === 2 ? historical : live),
        streamDevTools: async function* (_runId, afterSeq) {
          resyncs.push(afterSeq);
        },
      }),
    });

    store.connect("run-store");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: live });
    await store.scrubTo(2);
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(6, [task(4, "task:new-live", "running")]) });

    expect(store.mode).toEqual({ kind: "historical", frameNo: 2 });
    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:past");
    expect(store.bufferedLiveEvents).toBe(1);

    store.returnToLive();

    expect(store.mode).toEqual({ kind: "live" });
    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:new-live");
    expect(store.bufferedLiveEvents).toBe(0);
    expect(resyncs).toContain(undefined);
    store.disconnect();
  });

  test("scrubTo returns to live at or beyond the latest frame and records missing-run errors", async () => {
    const store = new DevToolsStore({
      client: fakeClient({ getDevToolsSnapshot: async () => snapshot(0, []) }),
    });

    await store.scrubTo(1);
    expect(store.scrubError).toMatchObject({ code: "PI_RUN_NOT_FOUND" });

    store.connect("run-store");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(3, [task(2, "task:a", "running")]) });
    await store.scrubTo(1);
    expect(store.mode).toEqual({ kind: "historical", frameNo: 0 });
    await store.scrubTo(3);
    expect(store.mode).toEqual({ kind: "live" });
    store.disconnect();
  });

  test("rewind requires confirmation and a historical live run, then records audit toast and returns live", async () => {
    const toasts: string[] = [];
    const calls: string[] = [];
    const afterRewind = snapshot(9, [task(2, "task:rewound", "running")]);
    const store = new DevToolsStore({
      toastSink: (message) => toasts.push(message),
      client: fakeClient({
        rewind: async (_runId, frameNo, confirm) => {
          calls.push(`${frameNo}:${confirm}`);
          return { auditRowId: "audit-rewind" };
        },
        getDevToolsSnapshot: async (_runId, frameNo) => frameNo === 1
          ? snapshot(1, [task(3, "task:past", "finished")])
          : afterRewind,
        streamDevTools: async function* () {},
      }),
    });

    await store.rewind(1, true);
    expect(store.rewindError).toMatchObject({ code: "PI_RUN_NOT_FOUND" });

    store.connect("run-store");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(4, [task(2, "task:live", "running")]) });
    await store.rewind(1, false);
    expect(calls).toEqual([]);
    await store.rewind(1, true);
    expect(store.rewindError).toMatchObject({ code: "PI_CONFIRMATION_REQUIRED" });

    await store.scrubTo(1);
    await store.rewind(1, true);

    expect(calls).toEqual(["1:true"]);
    expect(store.mode).toEqual({ kind: "live" });
    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:rewound");
    expect(store.lastAuditRowId).toBe("audit-rewind");
    expect(toasts).toEqual(["Rewound to frame 1. Audit: audit-rewind"]);
    store.disconnect();
  });

  test("ghost node budget evicts oldest removed records and clears an evicted ghost selection", () => {
    const store = new DevToolsStore({ ghostNodeCap: 1 });
    const first = snapshot(0, [
      task(2, "task:first", "finished", { output: "first" }),
      task(3, "task:second", "finished", { output: "second" }),
    ]);
    const second = snapshot(1, [task(3, "task:second", "finished", { output: "second" })]);
    const third = snapshot(2, []);

    store.applyEvent({ version: 1, kind: "snapshot", snapshot: first });
    store.selectNode(2);
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: second });
    expect(store.isGhost).toBe(true);
    expect(store.ghostNodes.has("task:first")).toBe(true);

    store.applyEvent({ version: 1, kind: "snapshot", snapshot: third });

    expect([...store.ghostNodes.keys()]).toEqual(["task:second"]);
    expect(store.isGhost).toBe(false);
    expect(store.selectedNodeId).toBeUndefined();
  });
});

describe("DevToolsStore reconnect state", () => {
  test("failed streams mark stale state, reveal the stale banner, and reconnect with last seen seq", async () => {
    const attempts: Array<number | undefined> = [];
    const store = new DevToolsStore({
      staleBannerDelayMs: 5,
      client: fakeClient({
        streamDevTools: async function* (_runId, afterSeq) {
          attempts.push(afterSeq);
          if (attempts.length === 1) {
            yield { version: 1, kind: "snapshot", snapshot: snapshot(3, [task(2, "task:a", "running")]) };
          }
          throw new Error("stream dropped");
        },
      }),
    });

    store.connect("run-store");
    await waitFor(() => attempts.length >= 2 && store.reconnectCount >= 1 && store.isStaleBannerVisible);

    expect(store.connectionState.kind).toBe("error");
    expect(store.staleSince).toBeInstanceOf(Date);
    expect(store.reconnectCount).toBeGreaterThanOrEqual(1);
    expect(attempts[0]).toBeUndefined();
    expect(attempts[1]).toBe(3);
    store.disconnect();
  });

  test("decode errors increment the counter and force the next reconnect to request a fresh stream", async () => {
    const attempts: Array<number | undefined> = [];
    const store = new DevToolsStore({
      staleBannerDelayMs: 5,
      client: fakeClient({
        streamDevTools: async function* (_runId, afterSeq) {
          attempts.push(afterSeq);
          if (attempts.length === 1) {
            throw new Error("DevTools event must be an object.");
          }
        },
      }),
    });

    store.connect("run-store");
    await waitFor(() => attempts.length >= 2);

    expect(store.decodeErrorCount).toBe(1);
    expect(attempts).toEqual([undefined, undefined]);
    store.disconnect();
  });
});
