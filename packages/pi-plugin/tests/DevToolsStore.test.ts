import { afterEach, describe, expect, test } from "bun:test";
import { WebSocketServer } from "ws";
import { diffSnapshots } from "@smithers-orchestrator/devtools";
import { DevToolsClient } from "../src/runtime/DevToolsClient.js";
import { DevToolsStore } from "../src/runtime/DevToolsStore.js";
import { RunInspector } from "../src/views/RunInspector.js";
import type { DevToolsNode, DevToolsSnapshot } from "@smithers-orchestrator/protocol";

function task(id: number, nodeId: string, state: string, extraProps: Record<string, unknown> = {}): DevToolsNode {
  return {
    id,
    type: "task",
    name: "Task",
    props: { state, ...extraProps },
    task: { nodeId, kind: "compute", label: nodeId, iteration: 0 },
    children: [],
    depth: 1,
  };
}

function snapshot(seq: number, children: DevToolsNode[]): DevToolsSnapshot {
  return {
    version: 1,
    runId: "run-test",
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

function stable(value: unknown) {
  return JSON.stringify(value);
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

describe("DevToolsStore", () => {
  test("delta application yields a byte-identical fresh snapshot fixture", () => {
    const first = snapshot(0, [task(2, "task:a", "running")]);
    const fresh = snapshot(1, [
      task(2, "task:a", "finished", { output: { value: 1 } }),
      task(3, "task:b", "running"),
    ]);
    const delta = diffSnapshots(first, fresh);
    const store = new DevToolsStore({ ghostNodeCap: 8 });

    store.applyEvent({ version: 1, kind: "snapshot", snapshot: first });
    store.applyEvent({ version: 1, kind: "delta", delta });

    expect(stable({ version: 1, runId: "run-test", frameNo: store.latestFrameNo, seq: store.seq, root: store.tree }))
      .toBe(stable(fresh));
  });

  test("GapResync keeps the old displayed tree, discards deltas, then accepts a snapshot", () => {
    const first = snapshot(1, [task(2, "task:a", "running")]);
    const ignored = diffSnapshots(first, snapshot(3, [task(2, "task:a", "failed")]));
    const fresh = snapshot(4, [task(4, "task:fresh", "running")]);
    const store = new DevToolsStore({ ghostNodeCap: 8 });

    store.applyEvent({ version: 1, kind: "snapshot", snapshot: first });
    store.applyEvent({ version: 1, kind: "gapResync", gapResync: { fromSeq: 1, toSeq: 3 } });
    store.applyEvent({ version: 1, kind: "delta", delta: ignored });

    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:a");

    store.applyEvent({ version: 1, kind: "snapshot", snapshot: fresh });

    expect(store.seq).toBe(4);
    expect(store.tree?.children[0]?.task?.nodeId).toBe("task:fresh");
  });

  test("ghost node selection keeps last values and badge metadata", () => {
    const first = snapshot(0, [task(2, "task:ghost", "running", { output: "last value" })]);
    const fresh = snapshot(1, []);
    const delta = diffSnapshots(first, fresh);
    const store = new DevToolsStore({ ghostNodeCap: 8 });

    store.applyEvent({ version: 1, kind: "snapshot", snapshot: first });
    store.selectNode(2);
    store.applyEvent({ version: 1, kind: "delta", delta });

    expect(store.isGhost).toBe(true);
    expect(store.selectedNode?.task?.nodeId).toBe("task:ghost");
    expect(store.selectedNode?.props.output).toBe("last value");
    expect(store.selectedGhostRecord?.unmountedFrameNo).toBe(1);
  });
});

describe("DevToolsClient integration", () => {
  const servers: WebSocketServer[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  test("local gateway fixture live updates render in the inspector", async () => {
    const first = snapshot(0, [task(2, "task:a", "running")]);
    const fresh = snapshot(1, [task(2, "task:a", "finished", { output: { value: 42 } })]);
    const delta = diffSnapshots(first, fresh);
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(server);

    server.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.method === "connect") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 1 } }));
        }
        if (frame.method === "streamDevTools") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { streamId: "stream-1" } }));
          ws.send(JSON.stringify({
            type: "event",
            event: "devtools.event",
            payload: { streamId: "stream-1", runId: "run-test", event: { version: 1, kind: "snapshot", snapshot: first } },
          }));
          ws.send(JSON.stringify({
            type: "event",
            event: "devtools.event",
            payload: { streamId: "stream-1", runId: "run-test", event: { version: 1, kind: "delta", delta } },
          }));
        }
      });
    });

    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected TCP server address");
    }

    const client = new DevToolsClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const store = new DevToolsStore({ client });
    store.connect("run-test");

    await waitFor(() => store.seq === 1);

    const inspector = new RunInspector(store, client, { workflowName: "fixture" });
    const lines = inspector.render(100, 20, {
      fg: (_color, value) => value,
      bold: (value) => value,
    }).join("\n");

    expect(lines).toContain("task:a");
    expect(lines).toContain("finished");
    expect(lines).toContain("seq 1");
    store.disconnect();
  });
});
