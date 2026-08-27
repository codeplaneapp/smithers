/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Real DOM before react-dom/client, with Bun's native fetch preserved for the
// gateway's streaming SSE response (see hookComponents.test.tsx).
const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = nativeFetch;

import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { startInMemoryGateway, type InMemoryGateway } from "./inMemoryGateway.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix decides whether portals/layout effects are available at module load,
// so DOM-dependent imports must happen after happy-dom registration above.
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SmithersGatewayProvider } = await import("@smthrs/gateway-react");
const { HijackCandidateButton, RunSurface, hijackActionFor, hijackCandidateForNode, hijackCandidatesOf, ptyHijackUrl } =
  await import("../src/index.ts");
const { createSingleFlightPoller } = await import("../src/RunSurface.tsx");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RUN_ID = "run-surface";
const RUN = {
  runId: RUN_ID,
  workflow: "implement",
  workflowKey: "implement",
  status: "running",
  startedAtMs: Date.now() - 65_000,
  configJson: "{}",
};

let gateway: InMemoryGateway | undefined;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function mount(element: ReactElement) {
  gateway ??= startInMemoryGateway({
    runs: [RUN],
    hijackCandidates: {
      [RUN_ID]: [{ nodeId: "implement", engine: "claude", mode: "native-cli" }],
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        SmithersGatewayProvider,
        {
          options: { baseUrl: gateway!.baseUrl, token: "test-token" },
          mode: { kind: "local" as const, apiBaseUrl: gateway!.baseUrl, token: "test-token" },
        },
        element,
      ),
    );
  });
  await act(async () => {
    await sleep(60);
  });
  return {
    container,
    flush: async (ms = 30) => {
      await act(async () => {
        await sleep(ms);
      });
    },
  };
}

function click(el: Element | null) {
  if (!el) throw new Error("click: element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
});

describe("hijack model helpers", () => {
  test("read the HTTP envelope, match by node, and clamp the websocket geometry", () => {
    expect(
      hijackCandidatesOf({ ok: true, data: { candidates: [{ nodeId: "implement", engine: "claude" }, { junk: 1 }] } }),
    ).toEqual([{ nodeId: "implement", engine: "claude", mode: "native-cli" }]);
    const candidates = hijackCandidatesOf({ candidates: [{ nodeId: "a", engine: "codex", mode: "native-cli" }] });
    expect(hijackCandidateForNode(candidates, "a")?.engine).toBe("codex");
    expect(hijackCandidateForNode(candidates, "b")).toBeNull();
    expect(hijackActionFor("running", true, true)).toEqual({ kind: "hijack", label: "Hijack" });
    expect(hijackActionFor("running", false, true)).toBeNull();
    expect(hijackActionFor("finished", false, true)).toEqual({ kind: "reopen", label: "Reopen session" });
    expect(hijackActionFor("running", true, false)).toBeNull();
    expect(ptyHijackUrl("https://gateway.test", "run 1", "node/1", { cols: 120, rows: 40 }, "secret")).toBe(
      "wss://gateway.test/v1/pty/hijack?runId=run+1&nodeId=node%2F1&cols=120&rows=40&token=secret",
    );
  });
});

describe("RunSurface", () => {
  test("serializes polls and aborts the outstanding request on disposal", async () => {
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let aborted = false;
    const releases: Array<() => void> = [];
    const poller = createSingleFlightPoller(async (signal) => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => {
        let active = true;
        const finish = () => {
          if (!active) return;
          active = false;
          signal.removeEventListener("abort", onAbort);
          concurrent -= 1;
          resolve();
        };
        const onAbort = () => {
          aborted = true;
          finish();
        };
        releases.push(finish);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }, 5);

    poller.setActive(true);
    poller.pollNow();
    poller.pollNow();
    await sleep(10);
    expect(calls).toBe(1);
    expect(maxConcurrent).toBe(1);

    releases.shift()?.();
    await sleep(10);
    expect(calls).toBe(2);
    expect(maxConcurrent).toBe(1);

    poller.dispose();
    await sleep(10);
    expect(aborted).toBe(true);
    expect(calls).toBe(2);
  });

  test("shares one hijack-candidate request across duplicate buttons", async () => {
    function CandidateButtons() {
      const [showCompact, setShowCompact] = useState(true);
      const props = {
        runId: RUN_ID,
        nodeId: "implement",
        runStatus: "running",
        nodeLive: true,
        onOpen: () => {},
      };
      return createElement(
        "div",
        null,
        createElement(HijackCandidateButton, props),
        showCompact ? createElement(HijackCandidateButton, { ...props, compact: true }) : null,
        createElement("button", { type: "button", onClick: () => setShowCompact(false) }, "Hide compact"),
      );
    }

    const harness = await mount(createElement(CandidateButtons));
    await harness.flush(60);
    expect(gateway?.requests.filter((request) => request.path.endsWith("/hijack-candidates"))).toHaveLength(1);
    expect(harness.container.querySelector('[data-testid="monitor-hijack-button"]')?.textContent).toBe("Hijack");
    expect(harness.container.querySelector('[data-testid="monitor-hijack-inline"]')?.textContent).toContain("Hijack");

    await act(async () =>
      click(
        [...harness.container.querySelectorAll("button")].find((button) => button.textContent === "Hide compact") ??
          null,
      ),
    );
    expect(harness.container.querySelector('[data-testid="monitor-hijack-button"]')?.textContent).toBe("Hijack");
    expect(gateway?.requests.filter((request) => request.path.endsWith("/hijack-candidates"))).toHaveLength(1);
  });

  test("provides a candidate-aware monitor trigger without exporting its data hook", async () => {
    let openedEngine = "";
    const harness = await mount(
      createElement(HijackCandidateButton, {
        runId: RUN_ID,
        nodeId: "implement",
        runStatus: "running",
        nodeLive: true,
        onOpen: (candidate) => {
          openedEngine = candidate.engine;
        },
      }),
    );
    await harness.flush(60);
    const trigger = harness.container.querySelector('[data-testid="monitor-hijack-button"]');
    expect(trigger?.textContent).toBe("Hijack");
    await act(async () => click(trigger));
    expect(openedEngine).toBe("claude");
  });

  test("renders the run surface for a run, with the hijack terminal as a first-class tab", async () => {
    const harness = await mount(createElement(RunSurface, { runId: RUN_ID }));
    await harness.flush(150);
    const text = harness.container.textContent ?? "";
    expect(harness.container.querySelector("h1")?.textContent).toBe("implement");
    expect(text).toContain("Status");
    expect(text).toContain("Elapsed");
    expect(text).toContain("Files changed");
    const tabs = [...harness.container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs.some((label) => label?.includes("Chat"))).toBe(true);
    expect(tabs.some((label) => label?.includes("Terminal"))).toBe(true);
    expect(text).toContain("Hijack");
  });

  test("loads candidates from the provider gateway and exposes the first-class hijack action", async () => {
    const harness = await mount(createElement(RunSurface, { runId: RUN_ID, hijackNodeId: "implement" }));
    await harness.flush(60);
    expect(harness.container.querySelector('[data-testid="run-surface-hijack-button"]')?.textContent).toBe("Hijack");
    expect(
      [...harness.container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes("Terminal"))
        ?.textContent,
    ).toContain("1");
    expect(gateway?.requests.find((request) => request.path.endsWith("/hijack-candidates"))?.authorization).toBe(
      "Bearer test-token",
    );
  });

  test("adapts the same standalone surface to a chat-create run", async () => {
    const chatRunId = "run-chat";
    gateway = startInMemoryGateway({
      runs: [{ ...RUN, runId: chatRunId, workflowKey: "chat", status: "cancelled", configJson: "{}" }],
      hijackCandidates: {
        [chatRunId]: [{ nodeId: "chat", engine: "codex", mode: "native-cli" }],
      },
    });
    const harness = await mount(createElement(RunSurface, { runId: chatRunId }));
    await harness.flush(120);
    expect(harness.container.querySelector("h1")?.textContent).toBe("Chat");
    expect(harness.container.querySelector('[data-testid="run-surface-hijack-button"]')?.textContent).toBe(
      "Reopen session",
    );
    expect(harness.container.textContent).toContain("chat");
  });

  test("offers only the run controls: hijack, resume, pause, cancel", async () => {
    const harness = await mount(createElement(RunSurface, { runId: RUN_ID }));
    await harness.flush(150);
    const buttons = [...harness.container.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toContain("Resume");
    expect(buttons).toContain("Pause");
    expect(buttons).toContain("Cancel");
    expect(buttons).not.toContain("Restart");
    expect(harness.container.querySelector('[aria-label="Steering message"]')).toBeNull();
    expect(gateway?.requests.every((request) => !request.path.includes("-monitor/"))).toBe(true);
  });

  test("is maximizable when hosted, and not standalone (where it already fills the page)", async () => {
    const embedded = await mount(
      createElement(RunSurface, {
        runId: RUN_ID,
        variant: "embedded",
        "data-testid": "surface",
        onClose: () => {},
      }),
    );
    const panel = embedded.container.querySelector(".run-surface-embedded");
    expect(panel?.getAttribute("data-maximized")).toBe("false");
    const maximize = embedded.container.querySelector('[data-testid="run-surface-maximize"]');
    expect(maximize).not.toBeNull();
    await act(async () => click(maximize));
    expect(embedded.container.querySelector(".run-surface-embedded")?.getAttribute("data-maximized")).toBe("true");
    await act(async () => click(embedded.container.querySelector('[data-testid="run-surface-maximize"]')));
    expect(embedded.container.querySelector(".run-surface-embedded")?.getAttribute("data-maximized")).toBe("false");

    const standalone = await mount(createElement(RunSurface, { runId: RUN_ID }));
    expect(standalone.container.querySelector('[data-testid="run-surface-maximize"]')).toBeNull();
  });

  test("closes from the header when the host owns dismissal", async () => {
    let closed = 0;
    const harness = await mount(
      createElement(RunSurface, { runId: RUN_ID, variant: "embedded", onClose: () => (closed += 1) }),
    );
    await act(async () => click(harness.container.querySelector('[data-testid="run-surface-close"]')));
    expect(closed).toBe(1);
  });

  test("shows an empty state with no run", async () => {
    const harness = await mount(createElement(RunSurface, {}));
    expect(harness.container.textContent).toContain("No run selected");
  });

  test("renders a live working-copy diff while the run is still running", async () => {
    gateway = startInMemoryGateway({
      runs: [RUN],
      hijackCandidates: { [RUN_ID]: [] },
      runDiffs: {
        [RUN_ID]: {
          seq: 1,
          baseRef: "base",
          live: true,
          patches: [
            {
              path: "src/a.ts",
              operation: "modify",
              diff: "diff --git a/src/a.ts b/src/a.ts\nindex 0000000..1111111 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new-live\n",
            },
          ],
        },
      },
    });
    const harness = await mount(createElement(RunSurface, { runId: RUN_ID, initialTab: "diff" }));
    await harness.flush(150);
    const text = harness.container.textContent ?? "";
    expect(text).toContain("Live working-copy diff");
    // PierreDiffView parsed the seeded patch (line stats), so the diff tab is
    // showing live content, not the old terminal-state gate.
    expect(text).toContain("+1 -1");
    expect(text).not.toContain("terminal state");
  });

  test("refetches the diff on run events while the run is live", async () => {
    gateway = startInMemoryGateway({
      runs: [RUN],
      hijackCandidates: { [RUN_ID]: [] },
      runDiffs: {
        [RUN_ID]: { seq: 1, baseRef: "base", live: true, patches: [] },
      },
    });
    const harness = await mount(createElement(RunSurface, { runId: RUN_ID, initialTab: "diff" }));
    await harness.flush(150);
    const diffRequests = () => gateway?.requests.filter((request) => request.path.endsWith("/v1/rpc/getRunDiff")) ?? [];
    const before = diffRequests().length;
    expect(before).toBeGreaterThan(0);
    gateway?.pushEvents(RUN_ID, [{ seq: 1, event: "tool.use", payload: { nodeId: "implement" } }]);
    // Trailing debounce (1.5s) settles, then the refetch lands.
    await harness.flush(2000);
    expect(diffRequests().length).toBeGreaterThan(before);
  });
});
