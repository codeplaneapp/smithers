/** @jsxImportSource @opentui/react */
import { it, expect } from "bun:test";
import { useState, act } from "react";
import { useKeyboard } from "@opentui/react";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import { AppBody } from "../src/App.tsx";
import { TimelineView } from "../src/modes/TimelineMode.tsx";

/**
 * CI-safe render tests for the help-overlay contract, using the REAL pieces
 * production composes: `AppBody` (keeps the active mode MOUNTED and provides
 * OverlayOpenContext while `HelpOverlay` renders absolutely positioned on top)
 * wrapped around the REAL `TimelineView`. The harness owns only the `?` toggle
 * state, mirroring App's handler. Locks the two overlay regressions:
 *  - opening help must NOT unmount the mode (its local state — here the scrub
 *    position — must survive), and
 *  - mode keys must NOT leak through while the overlay is open.
 */

function frame(seq: number, event: string, payload?: unknown): GatewayEventFrame {
  return { type: "event", seq, event, payload, stateVersion: seq };
}

const EVENTS: GatewayEventFrame[] = [
  frame(1, "run.start"),
  frame(2, "node.start", { nodeId: "n-1", name: "fetch-data", status: "running" }),
  frame(3, "tool.use", { nodeId: "n-1", toolName: "read_file" }),
  frame(4, "node.end", { nodeId: "n-1", status: "done" }),
  frame(5, "node.start", { nodeId: "n-2", name: "process", status: "running" }),
  frame(6, "node.end", { nodeId: "n-2", status: "done" }),
  frame(7, "run.event", { nodeId: "n-2", text: "wrap-up" }),
  frame(8, "run.end", {}),
];

function OverlayHarness({ events }: { events: GatewayEventFrame[] }) {
  const [showHelp, setShowHelp] = useState(false);
  useKeyboard((e) => {
    if (e.name === "?") setShowHelp((prev) => !prev);
  });
  return (
    <box width="100%" height="100%" flexDirection="column">
      <AppBody helpMode={showHelp ? 4 : null}>
        <TimelineView events={events} />
      </AppBody>
    </box>
  );
}

describeHeadlessRender("Help overlay – keeps the mode mounted and swallows its keys (CI-safe)", () => {
  it("preserves the Timeline scrub position across open/close and blocks leaked keys", async () => {
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<OverlayHarness events={EVENTS} />, { width: 120, height: 30 });
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[live]");

    // Scrub off live: mode-local state the overlay used to destroy.
    act(() => { mockInput.pressKey("k"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[f7]");

    // Open help: overlay renders ON TOP — the mode is still mounted and its
    // status row (top of the body, above the centered panel) stays visible.
    act(() => { mockInput.pressKey("?"); });
    await flush();
    await waitForVisualIdle();
    const overlayFrame = captureCharFrame();
    expect(overlayFrame).toContain("Keybindings");
    expect(overlayFrame).toContain("[f7]");

    // A mode key pressed while the overlay is open must NOT reach the mode.
    act(() => { mockInput.pressKey("j"); });
    await flush();
    await waitForVisualIdle();

    // Close help: the scrub position survived both the overlay and the leaked j.
    act(() => { mockInput.pressKey("?"); });
    await flush();
    await waitForVisualIdle();
    const closedFrame = captureCharFrame();
    expect(closedFrame).not.toContain("Keybindings");
    expect(closedFrame).toContain("[f7]");
    expect(closedFrame).not.toContain("[f8]");
    expect(closedFrame).not.toContain("[live]");

    renderer.destroy();
  });

  it("renders the overlay panel above the mode without blanking the whole screen", async () => {
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<OverlayHarness events={EVENTS} />, { width: 120, height: 30 });
    await waitForVisualIdle();

    act(() => { mockInput.pressKey("?"); });
    await flush();
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("Keybindings");
    // The mode's chrome outside the centered panel is still on screen.
    expect(f).toContain("TIMELINE");

    renderer.destroy();
  });
});
