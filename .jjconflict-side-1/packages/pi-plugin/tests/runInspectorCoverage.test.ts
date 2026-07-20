import { describe, expect, test } from "bun:test";
import { DevToolsStore } from "../src/runtime/DevToolsStore.js";
import { RunInspector } from "../src/views/RunInspector.js";
import type { DevToolsClient } from "../src/runtime/DevToolsClient.js";
import type { DevToolsNode, DevToolsSnapshot } from "@smithers-orchestrator/protocol";

const plainTheme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

function task(id: number, nodeId: string, state: string): DevToolsNode {
  return {
    id,
    type: "task",
    name: nodeId,
    props: { state, output: "value" },
    task: { nodeId, kind: "compute", label: nodeId, iteration: 0 },
    children: [],
    depth: 1,
  };
}

function snapshot(children: DevToolsNode[]): DevToolsSnapshot {
  return {
    version: 1,
    runId: "run-inspector",
    frameNo: 3,
    seq: 3,
    root: { id: 1, type: "workflow", name: "Workflow", props: { state: "running" }, children, depth: 0 },
  };
}

function storeWithSelectedTask() {
  const store = new DevToolsStore();
  store.runId = "run-inspector";
  store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot([task(2, "task:a", "running")]) });
  store.selectNode(2);
  return store;
}

function fakeClient(overrides: Partial<DevToolsClient>): DevToolsClient {
  return overrides as DevToolsClient;
}

describe("RunInspector keyboard dispatch", () => {
  test("routes each shortcut to its action and reports approve/deny/cancel results", async () => {
    const store = storeWithSelectedTask();
    const notes: Array<{ message: string; level?: string }> = [];
    let closed = 0;
    const calls: string[] = [];
    const client = fakeClient({
      approve: async () => {
        calls.push("approve");
        return { auditRowId: "a" };
      },
      deny: async () => {
        calls.push("deny");
        return { auditRowId: "d" };
      },
      cancel: async () => {
        calls.push("cancel");
        return { auditRowId: "c" };
      },
    });
    const inspector = new RunInspector(store, client, {
      workflowName: "wf",
      theme: plainTheme,
      onClose: () => {
        closed += 1;
      },
      onNotify: (message, level) => notes.push({ message, level }),
    });

    inspector.handleInput("\t"); // cycleFocus +1 -> inspector
    inspector.handleInput("\x1b[Z"); // shift+tab -> cycleFocus -1
    inspector.handleInput("a");
    inspector.handleInput("d");
    inspector.handleInput("c");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(calls).toEqual(["approve", "deny", "cancel"]);
    expect(notes.some((n) => n.message.includes("Approved"))).toBe(true);
    expect(notes.some((n) => n.message.includes("Denied"))).toBe(true);
    expect(notes.some((n) => n.message.includes("Cancelling"))).toBe(true);

    inspector.handleInput("l"); // returnToLive
    inspector.handleInput("s"); // focus scrubber
    inspector.handleInput(","); // scrubber handles left
    inspector.handleInput("q"); // close
    expect(closed).toBe(1);

    inspector.dispose();
    expect((store as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
  });

  test("default onClose and onNotify sinks are invoked without options", async () => {
    const store = storeWithSelectedTask();
    store.clearSelection();
    // No options -> the constructor installs no-op onClose/onNotify sinks.
    const inspector = new RunInspector(store, fakeClient({}));

    // Approve with no task selected drives the default onNotify sink.
    inspector.handleInput("a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Escape drives the default onClose sink. Neither must throw.
    inspector.handleInput("\x1b");
  });

  test("inspector-focused input is consumed before the tree, and enter focuses the inspector", () => {
    const store = storeWithSelectedTask();
    const inspector = new RunInspector(store, fakeClient({}), { theme: plainTheme });

    // Focus the inspector pane, then a digit tab key is handled there.
    inspector.handleInput("\t"); // focus -> inspector
    inspector.handleInput("1"); // inspector handles -> returns early

    // Enter through the tree fallback focuses the inspector pane.
    inspector.handleInput("\x1b[Z"); // back to tree
    inspector.handleInput("\r"); // tree focusInspector
    // A subsequent inspector key is now consumed by the inspector pane.
    expect(inspector.handleInput("2")).toBeUndefined();
  });

  test("actions with no selected task or missing runId notify or no-op", async () => {
    const store = storeWithSelectedTask();
    store.clearSelection();
    const notes: Array<{ message: string; level?: string }> = [];
    const inspector = new RunInspector(store, fakeClient({}), {
      theme: plainTheme,
      onNotify: (message, level) => notes.push({ message, level }),
    });

    inspector.handleInput("a"); // no task -> warning
    inspector.handleInput("d"); // no task -> warning
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notes.filter((n) => n.level === "warning").length).toBeGreaterThanOrEqual(2);

    // cancelRun with no runId is a silent no-op.
    store.runId = undefined;
    inspector.handleInput("c");
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  test("approve/deny/cancel surface client errors through onNotify", async () => {
    const store = storeWithSelectedTask();
    const notes: Array<{ message: string; level?: string }> = [];
    const client = fakeClient({
      approve: async () => {
        throw new Error("approve boom");
      },
      deny: async () => {
        throw new Error("deny boom");
      },
      cancel: async () => {
        throw "cancel boom";
      },
    });
    const inspector = new RunInspector(store, client, {
      theme: plainTheme,
      onNotify: (message, level) => notes.push({ message, level }),
    });

    inspector.handleInput("a");
    inspector.handleInput("d");
    inspector.handleInput("c");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(notes.some((n) => n.level === "error" && n.message.includes("approve boom"))).toBe(true);
    expect(notes.some((n) => n.level === "error" && n.message.includes("deny boom"))).toBe(true);
    expect(notes.some((n) => n.level === "error" && n.message.includes("cancel boom"))).toBe(true);
  });

  test("rewind is refused when not eligible and runs when viewing a historical frame", async () => {
    const notes: Array<{ message: string; level?: string }> = [];
    let rewound = 0;
    const client = fakeClient({
      rewind: async () => {
        rewound += 1;
        return { auditRowId: "rw" };
      },
      getDevToolsSnapshot: async () => snapshot([task(2, "task:a", "running")]),
      streamDevTools: async function* () {},
    });
    // The rewind action goes through store.rewind, which uses the STORE's client.
    const store = new DevToolsStore({ client });
    store.runId = "run-inspector";
    store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot([task(2, "task:a", "running")]) });
    store.selectNode(2);
    const inspector = new RunInspector(store, client, {
      theme: plainTheme,
      onNotify: (message, level) => notes.push({ message, level }),
    });

    // Live mode -> not eligible -> warning.
    inspector.handleInput("w");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(notes.some((n) => n.level === "warning")).toBe(true);
    expect(rewound).toBe(0);

    // Enter historical mode so rewind is eligible (isRewindEligible: historical
    // + not finished + not in-flight).
    store.mode = { kind: "historical", frameNo: 1 };
    expect(store.isRewindEligible).toBe(true);
    inspector.handleInput("w");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rewound).toBe(1);
  });
});

describe("RunInspector rendering", () => {
  test("renders header, stale banner, panes and the focus footer", () => {
    const store = storeWithSelectedTask();
    store.isStaleBannerVisible = true;
    store.staleSince = new Date(Date.now() - 4_000);
    const inspector = new RunInspector(store, fakeClient({}), { workflowName: "wf" });

    const first = inspector.render(120, 30, plainTheme).join("\n");
    expect(first).toContain("stale: gateway disconnected");
    expect(first).toContain("focus:");
  });

  test("never caches while the stale banner is visible, so its seconds counter ticks", () => {
    const store = storeWithSelectedTask();
    store.isStaleBannerVisible = true;
    store.staleSince = new Date(Date.now() - 4_000);
    const inspector = new RunInspector(store, fakeClient({}), { workflowName: "wf" });

    expect(inspector.render(120, 30, plainTheme).join("\n")).toContain("disconnected for 4s");

    // Move staleSince back without emitting a store event (no invalidate()):
    // the next render must still recompute the counter.
    store.staleSince = new Date(Date.now() - 9_000);
    expect(inspector.render(120, 30, plainTheme).join("\n")).toContain("disconnected for 9s");
  });

  test("caches by width, height, and theme identity once the banner clears", () => {
    const store = storeWithSelectedTask();
    const inspector = new RunInspector(store, fakeClient({}), { workflowName: "wf" });

    const first = inspector.render(120, 30, plainTheme);
    // Same width/height/theme -> the exact cached array is returned.
    expect(inspector.render(120, 30, plainTheme)).toBe(first);

    // A vertical-only resize busts the cache and produces a taller layout.
    const taller = inspector.render(120, 40, plainTheme);
    expect(taller).not.toBe(first);
    expect(taller.length).toBeGreaterThan(first.length);

    // A different theme object busts the cache even at the same dimensions.
    const otherTheme = { ...plainTheme };
    expect(inspector.render(120, 40, otherTheme)).not.toBe(taller);

    // invalidate() clears the cache entirely.
    const cached = inspector.render(120, 40, otherTheme);
    expect(inspector.render(120, 40, otherTheme)).toBe(cached);
    inspector.invalidate();
    expect(inspector.render(120, 40, otherTheme)).not.toBe(cached);
  });
});
