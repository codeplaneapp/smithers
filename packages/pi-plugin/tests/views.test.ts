import { describe, expect, test } from "bun:test";
import { DevToolsStore } from "../src/runtime/DevToolsStore.js";
import { FrameScrubber } from "../src/views/FrameScrubber.js";
import { Header } from "../src/views/Header.js";
import { NodeInspector } from "../src/views/NodeInspector.js";
import { RunTree } from "../src/views/RunTree.js";
import type { DevToolsClient } from "../src/runtime/DevToolsClient.js";
import type { DevToolsNode, DevToolsSnapshot } from "@smithers-orchestrator/protocol";

const theme = {
  fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
  bold: (value: string) => `**${value}**`,
};
const plainTheme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

function task(
  id: number,
  nodeId: string,
  state: string,
  props: Record<string, unknown> = {},
  children: DevToolsNode[] = [],
): DevToolsNode {
  return {
    id,
    type: "task",
    name: nodeId,
    props: { state, ...props },
    task: { nodeId, kind: "compute", label: nodeId, agent: "agent-a", iteration: 1 },
    children,
    depth: 1,
  };
}

function snapshot(children: DevToolsNode[], extra: Partial<DevToolsSnapshot> = {}): DevToolsSnapshot {
  return {
    version: 1,
    runId: "run-views",
    frameNo: 12,
    seq: 12,
    root: {
      id: 1,
      type: "workflow",
      name: "Workflow",
      props: { state: "running" },
      children,
      depth: 0,
    },
    ...extra,
  };
}

function storeWithTree(children: DevToolsNode[]) {
  const store = new DevToolsStore();
  store.runId = "run-views";
  store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(children) });
  return store;
}

describe("RunTree", () => {
  test("renders auto-expanded running and failed paths, supports search, and moves selection", () => {
    const store = storeWithTree([
      task(2, "task:running", "running", { id: "alpha" }),
      task(3, "task:failed", "failed", { name: "bravo" }),
    ]);
    const tree = new RunTree(store);

    const initial = tree.render(100, 6, theme).join("\n");
    expect(initial).toContain("tree 3 rows");
    expect(initial).toContain("task:running");
    expect(initial).toContain("task:failed");
    expect(store.selectedNodeId).toBe(1);

    expect(tree.handleInput("j")).toBe("handled");
    expect(store.selectedNodeId).toBe(2);
    expect(tree.handleInput("/")).toBe("handled");
    expect(tree.handleInput("f")).toBe("handled");
    expect(tree.handleInput("a")).toBe("handled");
    expect(tree.handleInput("i")).toBe("handled");
    expect(tree.handleInput("l")).toBe("handled");
    const filtered = tree.render(100, 6, theme).join("\n");
    expect(filtered).toContain("/fail");
    expect(filtered).toContain("task:failed");
    expect(filtered).not.toContain("task:running");
    expect(tree.handleInput("\x1b")).toBe("handled");
    expect(tree.handleInput("\r")).toBe("focusInspector");
  });
});

describe("NodeInspector", () => {
  test("renders empty, output, diff, logs, error, tool calls, and ghost metadata states", () => {
    const store = storeWithTree([
      task(2, "task:inspect", "failed", {
        output: { value: 42 },
        diff: "- old\n+ new",
        logs: ["line one"],
        error: "boom",
        toolCalls: [{ name: "write_file", status: "done", sideEffect: "filesystem" }],
      }),
    ]);
    const inspector = new NodeInspector(store);

    expect(inspector.render(80, 4, theme).join("\n")).toContain("select a node");

    store.selectNode(2);
    const output = inspector.render(180, 16, theme).join("\n");
    expect(output).toContain("task:inspect");
    expect(output).toContain("boom");
    expect(output).toContain("write_file done filesystem");
    expect(output).toContain('"value": 42');

    expect(inspector.handleInput("2")).toBe("handled");
    expect(inspector.render(120, 10, theme).join("\n")).toContain("- old");
    expect(inspector.handleInput("3")).toBe("handled");
    expect(inspector.render(120, 12, plainTheme).join("\n")).toContain("line one");

    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot([], { frameNo: 13, seq: 13 }) });
    const ghost = inspector.render(160, 10, plainTheme).join("\n");
    expect(ghost).toContain("ghost: node no longer mounted at frame 13");
  });
});

describe("Header", () => {
  test("renders status, workflow, run id, seq, heartbeat ages, and non-streaming connection state", () => {
    const store = storeWithTree([task(2, "task:a", "running")]);
    store.connectionState = { kind: "connecting" };
    store.runStatus = "waiting-approval";
    store.runStateView = {
      state: "blocked",
      engineHeartbeatMs: 1_000,
      engineHeartbeatAtMs: Date.now() - 1_500,
      uiHeartbeatMs: 1_000,
      uiHeartbeatAtMs: Date.now() - 6_000,
    };
    const header = new Header(store, "fixture-workflow");

    const line = header.render(220, theme)[0] ?? "";

    expect(line).toContain("WAITING-APPROVAL");
    expect(line).toContain("fixture-workflow");
    expect(line).toContain("run-views");
    expect(line).toContain("blocked");
    expect(line).toContain("eng");
    expect(line).toContain("box");
    expect(line).toContain("seq 12");
    expect(line).toContain("connecting");
  });
});

describe("FrameScrubber", () => {
  test("renders live, historical, and error states and delegates keyboard input to the store", async () => {
    const calls: number[] = [];
    const store = storeWithTree([task(2, "task:a", "running")]);
    const originalScrubTo = store.scrubTo.bind(store);
    store.scrubTo = async (frameNo: number) => {
      calls.push(frameNo);
      await originalScrubTo(frameNo);
    };
    const scrubber = new FrameScrubber(store);

    expect(scrubber.render(140, plainTheme).join("\n")).toContain("live");
    expect(scrubber.handleInput("\x1b[D")).toBe(true);
    expect(calls).toEqual([11]);
    expect(scrubber.handleInput("\x1b[C")).toBe(true);
    expect(calls).toEqual([11, 12]);
    expect(scrubber.handleInput("x")).toBe(false);

    store.mode = { kind: "historical", frameNo: 4 };
    store.runningNodeCount = 2;
    store.scrubError = new Error("snapshot unavailable");
    const historical = scrubber.render(140, plainTheme).join("\n");
    expect(historical).toContain("viewing stale frame 4; live has 12. 2 running at this frame.");
    expect(historical).toContain("snapshot unavailable");

    expect(scrubber.handleInput("\x1b[H")).toBe(true);
    expect(calls.at(-1)).toBe(0);
    expect(scrubber.handleInput("\x1b[F")).toBe(true);
    expect(store.mode).toEqual({ kind: "live" });
  });

  test("rebinds historical inspection across previous/next frames and restores the live selection", async () => {
    const historical = new Map([
      [
        3,
        snapshot(
          [task(30, "task:chosen", "running"), task(31, "task:historical", "running", { output: "historical three" })],
          { frameNo: 3, seq: 3 },
        ),
      ],
      [
        4,
        snapshot(
          [task(40, "task:chosen", "finished"), task(41, "task:historical", "finished", { output: "historical four" })],
          { frameNo: 4, seq: 4 },
        ),
      ],
    ]);
    const store = new DevToolsStore({
      client: {
        getDevToolsSnapshot: async (_runId: string, frameNo?: number) => {
          const frame = historical.get(frameNo ?? -1);
          if (!frame) {
            throw new Error(`missing frame ${frameNo}`);
          }
          return frame;
        },
        streamDevTools: async function* () {},
      } as DevToolsClient,
    });
    const scrubber = new FrameScrubber(store);
    const inspector = new NodeInspector(store);

    store.connect("run-views");
    store.applyEvent({
      version: 1,
      kind: "snapshot",
      snapshot: snapshot([task(20, "task:chosen", "running", { output: "live five" })], {
        frameNo: 5,
        seq: 5,
      }),
    });
    store.selectNode(20);

    expect(scrubber.handleInput("\x1b[D")).toBe(true);
    expect(inspector.render(100, 10, plainTheme).join("\n")).toContain("loading historical frame 4");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.selectedNodeId).toBe(40);
    store.selectNode(41);
    expect(inspector.render(100, 10, plainTheme).join("\n")).toContain("historical four");

    expect(scrubber.handleInput("\x1b[D")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.selectedNodeId).toBe(31);
    expect(inspector.render(100, 10, plainTheme).join("\n")).toContain("historical three");

    expect(scrubber.handleInput("\x1b[C")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.selectedNodeId).toBe(41);
    expect(inspector.render(100, 10, plainTheme).join("\n")).toContain("historical four");

    store.applyEvent({
      version: 1,
      kind: "snapshot",
      snapshot: snapshot([task(60, "task:chosen", "running", { output: "live six" })], {
        frameNo: 6,
        seq: 6,
      }),
    });
    expect(scrubber.handleInput("\x1b[F")).toBe(true);
    expect(store.mode).toEqual({ kind: "live" });
    expect(store.selectedNodeId).toBe(60);
    expect(inspector.render(100, 10, plainTheme).join("\n")).toContain("live six");
    store.disconnect();
  });
});
