/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// See hookComponents.test.tsx: register a real DOM before react-dom/client is
// imported, but keep Bun's native fetch for the gateway's streaming SSE.
const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = nativeFetch;

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SmithersCollectionsProvider } from "@smithers-orchestrator/gateway-react";
import { FleetTable, NodeChatStream, NodeStageStrip, RunMeta } from "../src/index.ts";
import { startInMemoryGateway, type InMemoryGateway, type SeedState } from "./inMemoryGateway.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Harness = {
  container: HTMLElement;
  flush: (ms?: number) => Promise<void>;
  unmount: () => Promise<void>;
};

let gateway: InMemoryGateway | undefined;
const activeHarnesses: Harness[] = [];

function boot(seed: SeedState = {}): InMemoryGateway {
  gateway = startInMemoryGateway(seed);
  return gateway;
}

async function mount(gw: InMemoryGateway, element: ReactElement): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  const harness: Harness = {
    container,
    flush: async (ms = 20) => {
      await act(async () => {
        await sleep(ms);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
  activeHarnesses.push(harness);
  await act(async () => {
    root.render(
      createElement(
        SmithersCollectionsProvider,
        { mode: { kind: "local" as const, apiBaseUrl: gw.baseUrl } },
        element,
      ),
    );
  });
  await harness.flush();
  return harness;
}

async function waitFor(harness: Harness, assertion: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await harness.flush(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function click(el: Element | null) {
  if (!el) throw new Error("click: element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) {
    await harness.unmount().catch(() => undefined);
  }
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
});

const FLEET_TREE = {
  root: {
    id: 1,
    name: "Workflow",
    type: "workflow",
    task: { nodeId: "root" },
    children: [
      { id: 2, name: "preflight", type: "task", task: { nodeId: "preflight", state: "completed" } },
      { id: 3, name: "spec", type: "task", task: { nodeId: "spec-write", state: "in-progress" } },
      { id: 4, name: "a:implement", type: "task", task: { nodeId: "a:implement", state: "completed" } },
      { id: 5, name: "a:review", type: "task", task: { nodeId: "a:review", state: "in-progress" } },
      { id: 6, name: "b:implement", type: "task", task: { nodeId: "b:implement", state: "failed" } },
    ],
  },
  runState: { state: "running" },
};

describe("NodeChatStream (live SSE)", () => {
  test("retains an early node transcript after unrelated events evict the run ring", async () => {
    const unrelated = Array.from({ length: 1_025 }, (_, index) => ({
      runId: "run-a",
      seq: index + 2,
      event: "NodeOutput",
      payload: { nodeId: "other:node", text: `unrelated-${index}`, stream: "stdout" },
    }));
    const gw = boot({
      runs: [{ runId: "run-a", workflowKey: "fleet", status: "running" }],
      events: {
        "run-a": [
          { runId: "run-a", seq: 1, event: "NodeOutput", payload: { nodeId: "a:implement", text: "Early transcript.", stream: "stdout" } },
          ...unrelated,
        ],
      },
    });
    const harness = await mount(
      gw,
      createElement(NodeChatStream, { runId: "run-a", nodeId: "a:implement" }),
    );
    await waitFor(harness, () => harness.container.textContent?.includes("Early transcript.") === true, "early transcript");
    expect(harness.container.textContent).toContain("Early transcript.");
    expect(harness.container.textContent).not.toContain("unrelated-1024");
  }, 20_000);

  test("streams a node's chunks into chat bubbles and follows pushed events", async () => {
    const gw = boot({
      runs: [{ runId: "run-a", workflowKey: "fleet", status: "running" }],
      events: {
        "run-a": [
          { runId: "run-a", seq: 1, event: "NodeStarted", payload: { nodeId: "a:implement" } },
          { runId: "run-a", seq: 2, event: "NodeOutput", payload: { nodeId: "a:implement", iteration: 0, attempt: 1, text: "Reading the spec.", stream: "stdout" } },
          {
            runId: "run-a",
            seq: 3,
            event: "AgentEvent",
            payload: {
              nodeId: "a:implement",
              iteration: 0,
              attempt: 1,
              engine: "opencode",
              event: { type: "action", phase: "started", action: { kind: "tool", id: "t1", title: "Bash", detail: { input: { cmd: "bun test" } } } },
            },
          },
        ],
      },
    });
    const harness = await mount(
      gw,
      createElement(NodeChatStream, { runId: "run-a", nodeId: "a:implement", title: "Implement" }),
    );
    await waitFor(
      harness,
      () => harness.container.textContent?.includes("Reading the spec.") === true,
      "the seeded stdout chunk to render",
    );
    expect(harness.container.querySelector('[data-slot="chat-message"]')).not.toBeNull();
    expect(harness.container.textContent).toContain("Bash");
    expect(harness.container.querySelector('[data-slot="node-chat-stream"]')?.getAttribute("data-status")).toBe("running");

    gw.pushEvents("run-a", [
      { runId: "run-a", seq: 4, event: "NodeOutput", payload: { nodeId: "a:implement", iteration: 0, attempt: 1, text: " Done.", stream: "stdout" } },
      { runId: "run-a", seq: 5, event: "NodeFinished", payload: { nodeId: "a:implement" } },
    ]);
    // The tool call sits between the two text chunks, so the pushed chunk
    // starts a fresh bubble after the ToolCall rather than coalescing.
    await waitFor(
      harness,
      () => harness.container.textContent?.includes("Done.") === true,
      "the pushed chunk to append live",
    );
    expect(harness.container.querySelector('[data-slot="node-chat-stream"]')?.getAttribute("data-status")).toBe("ok");
  }, 20_000);

  test("renders the waiting empty state before any chunk arrives", async () => {
    const gw = boot({ runs: [{ runId: "run-a", workflowKey: "fleet", status: "running" }] });
    const harness = await mount(
      gw,
      createElement(NodeChatStream, { runId: "run-a", nodeId: "a:implement", status: "running" }),
    );
    await waitFor(
      harness,
      () => harness.container.textContent?.includes("Agent starting") === true,
      "the streaming empty state",
    );
  }, 15_000);
});

describe("FleetTable (live run tree)", () => {
  test("rolls up per-item pipeline status and handles selection", async () => {
    const gw = boot({ trees: { "run-a": FLEET_TREE } });
    const selections: string[] = [];
    const harness = await mount(
      gw,
      createElement(FleetTable, {
        runId: "run-a",
        columns: ["phase"],
        items: [
          { key: "a", title: "Item A", meta: ["group1"], nodeIds: ["a:implement", "a:review"] },
          { key: "b", title: "Item B", meta: ["group1"], nodeIds: ["b:implement"] },
          { key: "c", title: "Item C", meta: ["group2"], nodeIds: ["c:implement"] },
        ],
        selectedKey: "a",
        onSelect: (key: string) => selections.push(key),
      }),
    );
    await waitFor(
      harness,
      () => (harness.container.querySelectorAll("tbody tr").length ?? 0) === 3,
      "all fleet rows to render",
    );
    const pills = [...harness.container.querySelectorAll("tbody [data-status]")].map((el) =>
      el.getAttribute("data-status"),
    );
    await waitFor(harness, () => harness.container.querySelector('[data-status="running"]') !== null, "live statuses");
    expect([...harness.container.querySelectorAll("tbody [data-status]")].map((el) => el.getAttribute("data-status"))).toEqual([
      "running",
      "failed",
      "queued",
    ]);
    void pills;
    expect(harness.container.querySelector('tr[aria-selected="true"]')?.textContent).toContain("Item A");
    click(harness.container.querySelectorAll("tbody tr")[2] ?? null);
    expect(selections).toEqual(["c"]);
  }, 15_000);
});

describe("NodeStageStrip (live run tree)", () => {
  test("binds stage chips to live node statuses", async () => {
    const gw = boot({ trees: { "run-a": FLEET_TREE } });
    const harness = await mount(
      gw,
      createElement(NodeStageStrip, {
        runId: "run-a",
        stages: [
          { nodeId: "preflight" },
          { nodeId: "spec-write", label: "spec" },
          { nodeId: "deploy" },
        ],
      }),
    );
    await waitFor(
      harness,
      () => harness.container.textContent?.includes("spec") === true,
      "stage chips to render",
    );
    const strip = harness.container.querySelector('[data-slot="stage-strip"]') ?? harness.container;
    expect(strip.textContent).toContain("preflight");
    expect(strip.textContent).toContain("deploy");
  }, 15_000);
});

describe("RunMeta (live run)", () => {
  test("shows run id, live status pill, and connection badge", async () => {
    const gw = boot({
      runs: [
        {
          runId: "run-a",
          workflowKey: "fleet",
          status: "running",
          startedBy: { harness: "claude-code", sessionId: "session-1", detected: true, prompt: "private" },
        },
      ],
    });
    const harness = await mount(gw, createElement(RunMeta, { runId: "run-a" }));
    await waitFor(
      harness,
      () => harness.container.querySelector('[data-slot="run-meta"] [data-status="running"]') !== null,
      "the live run status pill",
    );
    expect(harness.container.textContent).toContain("run-a");
    const attribution = harness.container.querySelector('[data-slot="run-started-by"]');
    expect(attribution?.textContent).toBe("claude-code");
    expect(attribution?.getAttribute("aria-label")).toContain("session-1");
    expect(attribution?.getAttribute("aria-label")).toContain("auto-detected");
    expect(attribution?.textContent).not.toContain("private");
  }, 15_000);
});
