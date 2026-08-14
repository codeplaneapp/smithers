import { describe, expect, test } from "bun:test";
import { DevToolsStore } from "../src/runtime/DevToolsStore.js";
import type { DevToolsClient } from "../src/runtime/DevToolsClient.js";
import type { DevToolsDelta, DevToolsNode, DevToolsSnapshot } from "@smthrs/protocol";

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

function snapshot(seq: number, children: DevToolsNode[], runId = "run-cov"): DevToolsSnapshot {
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

describe("DevToolsStore residual coverage", () => {
  test("every derived accessor is readable directly", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
    // Before any event.
    expect(store.heartbeatAgeMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(store.selectedNode).toBeUndefined();
    expect(store.selectedGhostRecord).toBeUndefined();
    expect(store.displayedFrameNo).toBe(0);
    expect(store.isRunFinished).toBe(false);
    expect(store.isRewindEligible).toBe(false);

    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(3, [task(2, "task:a", "running")]) });
    expect(store.displayedFrameNo).toBe(3);
    // Historical mode surfaces the frozen frame number.
    store.mode = { kind: "historical", frameNo: 1 };
    expect(store.displayedFrameNo).toBe(1);
    store.mode = { kind: "live" };
  });

  test("a snapshot carrying an explicit runState string drives runStatus off it", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
    const snap = snapshot(1, [task(2, "task:a", "finished")]);
    (snap as unknown as { runState: Record<string, unknown> }).runState = { state: "cancelled" };
    store.applySnapshot(snap as DevToolsSnapshot);
    expect(store.runStatus).toBe("cancelled");
    expect(store.runStateView).toEqual({ state: "cancelled" });
  });

  test("a delta whose replaceRoot drops a node captures it as a ghost", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
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
    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:new");
  });

  test("a delta with a stale base seq triggers a resync request", () => {
    const streams: Array<number | undefined> = [];
    const store = new DevToolsStore({
      client: fakeClient({
        streamDevTools: async function* (_runId, afterSeq) {
          streams.push(afterSeq);
        },
      }),
    });
    store.connect("run-cov");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(5, [task(2, "task:a", "running")]) });

    const mismatched: DevToolsDelta = {
      version: 1,
      baseSeq: 99,
      seq: 100,
      ops: [],
    } as DevToolsDelta;
    store.applyEvent({ version: 1, kind: "delta", delta: mismatched });
    // Stale delta is dropped; the tree is unchanged.
    expect(store.seq).toBe(5);
    store.disconnect();
  });

  test("a delta that fails to apply requests a resync and keeps prior state", () => {
    const store = new DevToolsStore({
      client: fakeClient({
        streamDevTools: async function* () {},
      }),
    });
    store.connect("run-cov");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(1, [task(2, "task:a", "running")]) });

    // removeNode targeting the root id is rejected by applyDelta -> catch path.
    const bad: DevToolsDelta = {
      version: 1,
      baseSeq: 1,
      seq: 2,
      ops: [{ op: "removeNode", id: 1 }],
    } as DevToolsDelta;
    store.applyEvent({ version: 1, kind: "delta", delta: bad });
    expect(store.seq).toBe(1);
    store.disconnect();
  });

  test("a snapshot for a different run disconnects the store", () => {
    const store = new DevToolsStore({
      client: fakeClient({ streamDevTools: async function* () {} }),
    });
    store.connect("run-cov");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(1, [task(2, "task:a", "running")]) });
    // A snapshot from a different runId is treated as a mismatch.
    store.applyEvent({
      version: 1,
      kind: "snapshot",
      snapshot: snapshot(2, [task(2, "task:a", "running")], "run-other"),
    });
    // The mismatched snapshot is rejected: disconnect() clears runId and the
    // displayed seq stays on the accepted frame.
    expect(store.runId).toBeUndefined();
    expect(store.seq).toBe(1);
  });

  test("requestResync is a no-op when the store is not reconnecting", () => {
    let streamed = 0;
    const store = new DevToolsStore({
      client: fakeClient({
        streamDevTools: async function* () {
          streamed += 1;
        },
      }),
    });
    // Never connected -> shouldReconnect is false -> requestResync returns early.
    (store as unknown as { requestResync: (runId: string) => void }).requestResync("run-cov");
    expect(streamed).toBe(0);
  });
});

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

describe("DevToolsStore standalone lifecycle coverage", () => {
  test("selection follows a live node, becomes a ghost, and clears", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
    store.applyEvent({
      version: 1,
      kind: "snapshot",
      snapshot: snapshot(0, [task(2, "task:x", "running", { output: "v" })]),
    });

    store.selectNode(2);
    expect(store.selectedNode?.task?.nodeId).toBe("task:x");
    expect(store.isGhost).toBe(false);

    // The node unmounts -> selection follows it into the ghost record.
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(1, []) });
    expect(store.isGhost).toBe(true);
    expect(store.selectedGhostRecord?.node.task?.nodeId).toBe("task:x");
    expect(store.selectedNode?.props.output).toBe("v");

    // Dropping the ghost record leaves a stale selection with no live node and no
    // ghost key -> updateGhostState clears the selection entirely.
    store.clearHistory();
    expect(store.selectedNodeId).toBeUndefined();
    expect(store.isGhost).toBe(false);

    store.selectNode(undefined);
    store.clearSelection();
    expect(store.isGhost).toBe(false);
    expect(store.selectedNode).toBeUndefined();
  });

  test("applyGapResync keeps the live tree until a fresh snapshot arrives", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(1, [task(2, "task:a", "running")]) });

    store.applyGapResync({ fromSeq: 1, toSeq: 3 });
    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:a");
    expect(store.seq).toBe(1);

    // The next snapshot is accepted even though the resync cleared the live baseline.
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(4, [task(5, "task:fresh", "running")]) });
    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:fresh");
  });

  test("clearHistory drops ghosts; isGhostNode and ghostRecord read them back first", () => {
    const store = new DevToolsStore({ ghostNodeCap: 8 });
    const ghost = task(2, "task:g", "finished", { output: "kept" });
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(0, [ghost]) });
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(1, []) });

    expect(store.isGhostNode(ghost)).toBe(true);
    expect(store.ghostRecord(ghost)?.node.task?.nodeId).toBe("task:g");
    const keyless = { ...ghost, task: undefined } as typeof ghost;
    expect(store.isGhostNode(keyless)).toBe(false);
    expect(store.ghostRecord(keyless)).toBeUndefined();

    store.clearHistory();
    expect(store.ghostNodes.size).toBe(0);
    expect(store.isGhostNode(ghost)).toBe(false);
  });

  test("error clearers reset scrub/rewind errors and notify subscribers", () => {
    const store = new DevToolsStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.scrubError = new Error("scrub");
    store.rewindError = new Error("rewind");

    const before = notifications;
    store.clearHistoricalError();
    store.clearRewindError();
    expect(store.scrubError).toBeUndefined();
    expect(store.rewindError).toBeUndefined();
    expect(notifications).toBe(before + 2);

    unsubscribe();
    store.clearHistoricalError();
    expect(notifications).toBe(before + 2);
  });

  test("scrubTo loads a historical frame, then returnToLive restores live and resyncs", async () => {
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

    store.connect("run-cov");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: live });
    await store.scrubTo(2);
    expect(store.mode).toEqual({ kind: "historical", frameNo: 2 });
    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:past");

    // A live event while historical is buffered, not displayed.
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(6, [task(4, "task:newer", "running")]) });
    expect(store.bufferedLiveEvents).toBe(1);

    store.returnToLive();
    expect(store.mode).toEqual({ kind: "live" });
    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:newer");
    expect(store.bufferedLiveEvents).toBe(0);
    expect(resyncs).toContain(undefined);
    store.disconnect();
  });

  test("scrubTo records a missing-run error and clamps to live beyond the latest frame", async () => {
    const store = new DevToolsStore({ client: fakeClient({ getDevToolsSnapshot: async () => snapshot(0, []) }) });
    await store.scrubTo(1);
    expect(store.scrubError).toMatchObject({ code: "PI_RUN_NOT_FOUND" });

    store.connect("run-cov");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(3, [task(2, "task:a", "running")]) });
    await store.scrubTo(9);
    expect(store.mode).toEqual({ kind: "live" });
    store.disconnect();
  });

  test("rewind enforces its guards, then succeeds, prunes late ghosts, and toasts", async () => {
    const toasts: string[] = [];
    const afterRewind = snapshot(9, [task(2, "task:anchor", "running")]);
    const store = new DevToolsStore({
      ghostNodeCap: 8,
      toastSink: (message) => toasts.push(message),
      client: fakeClient({
        rewind: async () => ({ auditRowId: "audit-1" }),
        getDevToolsSnapshot: async (_runId, frameNo) =>
          typeof frameNo === "number" ? snapshot(2, [task(2, "task:anchor", "running")]) : afterRewind,
        streamDevTools: async function* () {},
      }),
    });

    // No runId yet -> PI_RUN_NOT_FOUND. confirm=false is also a no-op.
    await store.rewind(1, false);
    await store.rewind(1, true);
    expect(store.rewindError).toMatchObject({ code: "PI_RUN_NOT_FOUND" });

    store.connect("run-cov");
    // Ghost mounted at frame 5, removed at 6.
    store.applyEvent({
      version: 1,
      kind: "snapshot",
      snapshot: snapshot(5, [task(2, "task:anchor", "running"), task(3, "task:ghosty", "running")]),
    });
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(6, [task(2, "task:anchor", "running")]) });
    expect(store.ghostNodes.has("task:ghosty")).toBe(true);

    // Live mode (not historical) -> confirmation-required guard.
    await store.rewind(2, true);
    expect(store.rewindError).toMatchObject({ code: "PI_CONFIRMATION_REQUIRED" });

    await store.scrubTo(2);
    await store.rewind(2, true);
    expect(store.mode).toEqual({ kind: "live" });
    expect(store.ghostNodes.has("task:ghosty")).toBe(false);
    expect(store.lastAuditRowId).toBe("audit-1");
    expect(toasts).toEqual(["Rewound to frame 2. Audit: audit-1"]);
    store.disconnect();
  });

  test("a successful rewind with no configured sink drives the default no-op toast", async () => {
    const afterRewind = snapshot(9, [task(2, "task:rewound", "running")]);
    const store = new DevToolsStore({
      client: fakeClient({
        rewind: async () => ({ auditRowId: undefined }),
        getDevToolsSnapshot: async (_runId, frameNo) =>
          frameNo === 1 ? snapshot(1, [task(3, "task:past", "finished")]) : afterRewind,
        streamDevTools: async function* () {},
      }),
    });
    store.connect("run-cov");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(4, [task(2, "task:live", "running")]) });
    await store.scrubTo(1);
    await store.rewind(1, true);
    // No auditRowId -> the shorter message; the default sink swallows it silently.
    expect(store.lastToastMessage).toBe("Rewound to frame 1.");
    expect(store.lastAuditRowId).toBeUndefined();
    store.disconnect();
  });

  test("rewind is refused on a finished run", async () => {
    const store = new DevToolsStore({
      client: fakeClient({ streamDevTools: async function* () {} }),
    });
    store.connect("run-cov");
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(1, [task(2, "task:a", "finished")]) });
    store.mode = { kind: "historical", frameNo: 0 };
    expect(store.isRunFinished).toBe(true);
    await store.rewind(0, true);
    expect(store.rewindError).toMatchObject({ code: "PI_REWIND_FAILED" });
    store.disconnect();
  });

  test("disconnecting mid-backoff aborts the pending sleep without another reconnect attempt", async () => {
    let attempts = 0;
    const store = new DevToolsStore({
      client: fakeClient({
        streamDevTools: async function* () {
          attempts += 1;
          throw new Error("stream dropped");
        },
      }),
    });

    store.connect("run-cov");
    // After the first failure the loop parks in sleep(1000ms) before retrying.
    await waitFor(() => store.reconnectCount >= 1);
    const attemptsBeforeDisconnect = attempts;

    // Disconnect aborts the in-flight backoff sleep (its abort listener fires),
    // so the loop exits instead of running another attempt.
    store.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(attempts).toBe(attemptsBeforeDisconnect);
    expect(store.connectionState.kind).toBe("disconnected");
  });

  test("a dropped stream marks stale, reveals the banner, and reconnects with the last seen seq", async () => {
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

    store.connect("run-cov");
    await waitFor(() => attempts.length >= 2 && store.reconnectCount >= 1 && store.isStaleBannerVisible);
    expect(store.connectionState.kind).toBe("error");
    expect(store.staleSince).toBeInstanceOf(Date);
    expect(attempts[0]).toBeUndefined();
    expect(attempts[1]).toBe(3);
    store.disconnect();
  });
});
