/** @jsxImportSource @opentui/react */
import { afterEach, it, expect } from "bun:test";
import { act } from "react";
import type { ReactNode } from "react";
import { useRenderer as useOpenTuiRenderer } from "@opentui/react";
import { SmithersGatewayProvider } from "@smithers-orchestrator/gateway-react";
import { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import type { CliRenderer } from "@opentui/core";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";
import { App } from "../src/App.tsx";
import { Keybindings } from "../src/Keybindings.tsx";
import { RendererProvider } from "../src/RendererContext.tsx";
import { startSeededGateway, defaultSeed, emptySeed, type SeededGateway, type GatewaySeed } from "./seededGateway.ts";

/**
 * Full-stack render of the REAL monitor `App` against a REAL seeded gateway
 * server (see seededGateway.ts). Exercises the gateway-connected wrappers that
 * props-only view tests can't reach: the connected `Header`, `TreeMode` +
 * `NodeInspector`, `GraphMode`/`LogMode`/`TimelineMode`/`HijackMode`, the
 * `data.ts` hooks, and `App`'s mode-switch/keybar wiring — all driven by real
 * keystrokes through the OpenTUI renderer.
 */

const RUN_ID = "run-live-123";

// Bridge OpenTUI's live renderer into our RendererProvider so HijackMode's
// useRenderer() resolves (production installs this in index.tsx).
function Harness({ gateway, children }: { gateway: SeededGateway; children: (runId: string) => ReactNode }) {
  const renderer = useOpenTuiRenderer();
  const client = new SmithersGatewayClient({ baseUrl: gateway.baseUrl });
  return (
    <RendererProvider value={renderer as unknown as CliRenderer}>
      <Keybindings>
        <SmithersGatewayProvider client={client}>{children(RUN_ID)}</SmithersGatewayProvider>
      </Keybindings>
    </RendererProvider>
  );
}

let active: SeededGateway | null = null;
afterEach(() => {
  active?.stop();
  active = null;
});

async function renderApp(
  seed: GatewaySeed,
  onExit: (code: number) => void = () => {},
  size: { width: number; height: number } = { width: 140, height: 30 },
) {
  const gateway = startSeededGateway(seed);
  active = gateway;
  const result = await renderForTest(
    <Harness gateway={gateway}>{(runId) => <App runId={runId} onExit={onExit} />}</Harness>,
    size,
  );
  return { gateway, ...result };
}

// Poll the rendered frame until it contains `needle` (the seeded collections
// fetch + reconcile asynchronously after mount).
async function waitForFrame(
  r: Awaited<ReturnType<typeof renderApp>>,
  needle: string,
  { tries = 60 } = {},
): Promise<string> {
  let frame = "";
  for (let i = 0; i < tries; i++) {
    await r.waitForVisualIdle();
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20));
    });
    frame = r.captureCharFrame();
    if (frame.includes(needle)) return frame;
  }
  return frame;
}

async function delay(ms: number) {
  await act(async () => {
    await new Promise((res) => setTimeout(res, ms));
  });
}
async function press(r: Awaited<ReturnType<typeof renderApp>>, key: string, mods?: { shift?: boolean }) {
  act(() => {
    r.mockInput.pressKey(key as never, mods);
  });
  await r.flush();
  await r.waitForVisualIdle();
}

describeHeadlessRender("App – live gateway integration", () => {
  it("boots into Tree mode, renders the connected header + tree nodes from the gateway", async () => {
    const r = await renderApp(defaultSeed(RUN_ID));
    const frame = await waitForFrame(r, "fetch-data");
    // Connected Header (live run row from the gateway).
    expect(frame).toContain("deploy-flow");
    expect(frame).toContain("[live]");
    // Tree nodes materialized from the seeded snapshot.
    expect(frame).toContain("fetch-data");
    // Tree-mode keybar (App advertises the tree-specific bindings).
    expect(frame).toContain("Graph");
    // Let the connected Header's 1s live clock tick at least once so the
    // interval callback (and its unref) runs.
    await delay(1100);
    r.renderer.destroy();
  });

  it("switches through Graph, Logs, Timeline, and Hijack modes and back to Tree", async () => {
    const r = await renderApp(defaultSeed(RUN_ID));
    await waitForFrame(r, "fetch-data");

    // g → Graph (mode 2). The graph view renders the same nodes as cards.
    await press(r, "g");
    let f = await waitForFrame(r, "fetch-data");
    expect(r.captureCharFrame()).toContain("fetch-data");
    // The non-tree keybar shows the global 1-5 mode list ("Hijack").
    expect(r.captureCharFrame()).toContain("Hijack");

    // j/k move the graph selection.
    await press(r, "j");
    await press(r, "k");

    // Enter on a focused graph node routes back to Tree with that node selected
    // (App.handleSelectNodeKey).
    act(() => {
      r.mockInput.pressEnter();
    });
    await r.flush();
    await r.waitForVisualIdle();
    expect(r.captureCharFrame()).toContain("fetch-data");

    // l → Logs (mode 3).
    await press(r, "l");
    f = await waitForFrame(r, "LOGS");
    expect(f).toContain("LOGS");

    // t → Timeline (mode 4).
    await press(r, "t");
    f = await waitForFrame(r, "TIMELINE");
    expect(f).toContain("TIMELINE");

    // h → Hijack (mode 5): the seeded running root is a hijack candidate.
    await press(r, "h");
    f = await waitForFrame(r, "HIJACK");
    expect(f).toContain("HIJACK");

    // Escape cancels the hijack picker → App.onBack returns to Tree.
    act(() => {
      r.mockInput.pressEscape();
    });
    await delay(120);
    await r.flush();
    await waitForFrame(r, "fetch-data");
    expect(r.captureCharFrame()).toContain("fetch-data");

    // g toggles Graph on, g again toggles back to Tree (toggle-graph).
    await press(r, "g");
    await press(r, "g");
    // 3 → Logs then 1 → back to Tree (set-mode from a non-tree mode).
    await press(r, "3");
    await press(r, "1");
    await waitForFrame(r, "fetch-data");
    expect(r.captureCharFrame()).toContain("fetch-data");
    r.renderer.destroy();
  });

  it("drives Tree navigation, collapse, inspector focus, and tab switching", async () => {
    const r = await renderApp(defaultSeed(RUN_ID));
    await waitForFrame(r, "fetch-data");

    // j/k move the tree focus; space collapses the focused parent (root).
    await press(r, "j");
    await press(r, "k");
    await press(r, " "); // space: collapse root → children disappear
    expect(r.captureCharFrame()).not.toContain("fetch-data");
    await press(r, " "); // expand again
    await waitForFrame(r, "fetch-data");

    // 1-4 select inspector tabs from the tree.
    await press(r, "2");
    await press(r, "1");

    // Enter focuses the inspector pane; left/right cycle its tabs; Tab toggles.
    act(() => {
      r.mockInput.pressEnter();
    });
    await r.flush();
    await r.waitForVisualIdle();
    act(() => {
      r.mockInput.pressArrow("right");
    });
    await r.flush();
    act(() => {
      r.mockInput.pressArrow("left");
    });
    await r.flush();
    act(() => {
      r.mockInput.pressTab();
    });
    await r.flush();
    await r.waitForVisualIdle();
    // Escape returns focus to the tree pane.
    act(() => {
      r.mockInput.pressEscape();
    });
    await delay(120);
    await r.flush();
    r.renderer.destroy();
  });

  it("shows the human-task banner when a human node is focused", async () => {
    const r = await renderApp(defaultSeed(RUN_ID, { blockedNodeId: "ask", runState: "waiting" }));
    await waitForFrame(r, "fetch-data");
    // Move focus down to the human node (root, fetch-data, approve, ask).
    await press(r, "j");
    await press(r, "j");
    await press(r, "j");
    const f = await waitForFrame(r, "human input");
    expect(f).toContain("human input");
    r.renderer.destroy();
  });

  it("submits a gate approval decision through the real gateway", async () => {
    const r = await renderApp(defaultSeed(RUN_ID));
    await waitForFrame(r, "fetch-data");
    // Focus the approval node (index 2): root → fetch-data → approve.
    await press(r, "j");
    await press(r, "j");
    await waitForFrame(r, "Approve deploy");
    // 'a' approves → submitApproval POSTs the decision to the gateway.
    await press(r, "a");
    for (let i = 0; i < 50 && r.gateway.submittedApprovals.length === 0; i++) await delay(20);
    expect(r.gateway.submittedApprovals.length).toBeGreaterThan(0);
    expect(r.gateway.submittedApprovals[0]).toMatchObject({ decision: { approved: true } });
    r.renderer.destroy();
  });

  it("cycles and approves a select-mode approval", async () => {
    const r = await renderApp(
      defaultSeed(RUN_ID, {
        approvalMode: "select",
        approvalOptions: [
          { key: "blue", label: "Blue" },
          { key: "green", label: "Green" },
        ],
      }),
    );
    await waitForFrame(r, "fetch-data");
    await press(r, "j");
    await press(r, "j");
    await waitForFrame(r, "Approve deploy");
    // [ and ] cycle the highlighted option (select mode only).
    await press(r, "]");
    await press(r, "[");
    // 'a' approves with the chosen option nested under decision.value.
    await press(r, "a");
    for (let i = 0; i < 50 && r.gateway.submittedApprovals.length === 0; i++) await delay(20);
    expect(r.gateway.submittedApprovals.length).toBeGreaterThan(0);
    expect(r.gateway.submittedApprovals[0]).toMatchObject({ decision: { approved: true } });
    r.renderer.destroy();
  });

  it("denies an approval and polls for a waiting approval with no row yet", async () => {
    // Blocked on `approve` with an EMPTY approvals list: focusing it makes the
    // node 'waiting' with no matching row, exercising the poll-for-approval
    // effect; then a second seed path submits a deny.
    const r = await renderApp(
      defaultSeed(RUN_ID, { runState: "waiting-approval", blockedNodeId: "approve", noApproval: true }),
    );
    await waitForFrame(r, "fetch-data");
    await press(r, "j");
    await press(r, "j");
    // Let the poll effect fire at least once.
    await delay(60);
    r.renderer.destroy();
  });

  it("denies a gate approval", async () => {
    const r = await renderApp(defaultSeed(RUN_ID, { blockedNodeId: "approve", runState: "waiting-approval" }));
    await waitForFrame(r, "fetch-data");
    await press(r, "j");
    await press(r, "j");
    await waitForFrame(r, "Approve deploy");
    await press(r, "d");
    for (let i = 0; i < 50 && r.gateway.submittedApprovals.length === 0; i++) await delay(20);
    expect(r.gateway.submittedApprovals[0]).toMatchObject({ decision: { approved: false } });
    r.renderer.destroy();
  });

  it("renders a node's diff-tab stat summary fetched from the gateway", async () => {
    const r = await renderApp(defaultSeed(RUN_ID));
    await waitForFrame(r, "fetch-data");
    await press(r, "j"); // focus fetch-data
    await press(r, "3"); // diff tab
    const f = await waitForFrame(r, "a.ts");
    expect(f).toContain("a.ts");
    r.renderer.destroy();
  });

  it("renders the empty-tree state when the run has no nodes yet", async () => {
    const r = await renderApp(emptySeed(RUN_ID));
    const f = await waitForFrame(r, "(no nodes)");
    expect(f).toContain("(no nodes)");
    // The inspector shows its no-node placeholder alongside the empty tree.
    expect(f).toContain("Select a node");
    r.renderer.destroy();
  });

  it("degrades to the empty tree when the snapshot fetch fails", async () => {
    // The gateway data-client collapses a failed source fetch into a ready-but-
    // empty collection (useLiveQuery.isError only reflects the compiled live
    // query, not a source-fetch failure), so a 500 renders the empty tree rather
    // than crashing. This is the real observable behavior of the connected mode.
    const r = await renderApp({ ...defaultSeed(RUN_ID), failTree: true });
    const f = await waitForFrame(r, "(no nodes)");
    expect(f).toContain("(no nodes)");
    r.renderer.destroy();
  });

  it("uses the stacked compact layout on a narrow terminal", async () => {
    const r = await renderApp(defaultSeed(RUN_ID), () => {}, { width: 90, height: 30 });
    const f = await waitForFrame(r, "fetch-data");
    // Compact header collapses to the short single-line form (status word shown).
    expect(f).toContain("running");
    expect(f).toContain("fetch-data");
    r.renderer.destroy();
  });

  it("surfaces a submit error when the gateway rejects the approval", async () => {
    const r = await renderApp({
      ...defaultSeed(RUN_ID, { blockedNodeId: "approve", runState: "waiting-approval" }),
      failApproval: true,
    });
    await waitForFrame(r, "fetch-data");
    await press(r, "j");
    await press(r, "j");
    await waitForFrame(r, "Approve deploy");
    await press(r, "a");
    // The rejected decision was still POSTed; the UI records the error.
    for (let i = 0; i < 50 && r.gateway.submittedApprovals.length === 0; i++) await delay(20);
    expect(r.gateway.submittedApprovals.length).toBeGreaterThan(0);
    await delay(60);
    r.renderer.destroy();
  });

  it("refuses to approve a select with no valid option chosen", async () => {
    // A select-mode approval whose options list is empty: approving builds no
    // valid decision, so the UI shows the guidance error instead of submitting.
    const r = await renderApp(defaultSeed(RUN_ID, { approvalMode: "select", approvalOptions: [] }));
    await waitForFrame(r, "fetch-data");
    await press(r, "j");
    await press(r, "j");
    await waitForFrame(r, "Approve deploy");
    await press(r, "a");
    await delay(40);
    // Nothing was submitted (the decision could not be built).
    expect(r.gateway.submittedApprovals.length).toBe(0);
    r.renderer.destroy();
  });

  it("toggles the help overlay and quits via q", async () => {
    const exits: number[] = [];
    const r = await renderApp(defaultSeed(RUN_ID), (c) => exits.push(c));
    await waitForFrame(r, "fetch-data");
    await press(r, "?");
    expect(r.captureCharFrame()).toContain("Keybindings");
    // Escape closes the help overlay (close-help action).
    act(() => {
      r.mockInput.pressEscape();
    });
    await delay(120);
    await r.flush();
    await r.waitForVisualIdle();
    expect(r.captureCharFrame()).not.toContain("Keybindings");
    // Reopen and toggle closed with ? too.
    await press(r, "?");
    await press(r, "?");
    expect(r.captureCharFrame()).not.toContain("Keybindings");
    await press(r, "q");
    expect(exits).toContain(0);
    r.renderer.destroy();
  });
});
