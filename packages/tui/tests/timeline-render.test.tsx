/** @jsxImportSource @opentui/react */
import { describe, it, expect } from "bun:test";
import { renderForTest } from "./renderHelpers.tsx";
import { act } from "react";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import { TimelineView } from "../src/modes/TimelineMode.tsx";

/**
 * CI-safe terminal rendering tests for TIMELINE mode.
 * No gateway, no agent CLI, no browser.
 * Uses @opentui/react testRender (headless OpenTUI renderer).
 *
 * These render the REAL presentational `TimelineView` (the same component
 * production mounts via `TimelineMode`) with injected event data and a stub
 * rewind callback — `TimelineMode` is a thin wrapper that only reads
 * `useRunEvents`/`useActions` and forwards them. So the view can't drift from
 * what these tests exercise.
 */

function frame(seq: number, event: string, payload?: unknown): GatewayEventFrame {
  return { type: "event", seq, event, payload, stateVersion: seq };
}

const CANNED_EVENTS: GatewayEventFrame[] = [
  frame(1, "run.start"),
  frame(2, "node.start", { nodeId: "node-alpha", name: "fetch-data", status: "running" }),
  frame(3, "tool.use", { nodeId: "node-alpha", toolName: "read_file" }),
  frame(4, "approval.request", { nodeId: "node-alpha", approvalTitle: "confirm-write" }),
  frame(5, "node.end", { nodeId: "node-alpha", status: "done" }),
  frame(6, "node.start", { nodeId: "node-beta", name: "process", status: "running" }),
  frame(7, "run.event", { nodeId: "node-beta", text: "processing" }),
  frame(8, "node.fail", { nodeId: "node-beta", status: "failed" }),
];

describe("TimelineMode – terminal rendering (CI-safe, no gateway)", () => {
  it("renders TIMELINE header and frame count", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();

    expect(f).toContain("TIMELINE");
    expect(f).toContain(`${CANNED_EVENTS.length} frames`);

    renderer.destroy();
  });

  it("starts in live mode showing [live]", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[live]");
    renderer.destroy();
  });

  it("renders tick strip with gate marker ⊛ for approval events", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    // Event seq 4 is approval.request — should render as ⊛
    expect(f).toContain("⊛");
    renderer.destroy();
  });

  it("renders tick strip with notable marker │ for tool events", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    // tool.use is notable → │
    expect(f).toContain("│");
    renderer.destroy();
  });

  it("shows node snapshots at last frame in live mode", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    // At last frame (seq 8, node-beta failed), both nodes should appear
    expect(f).toContain("fetch-data");
    expect(f).toContain("process");
    renderer.destroy();
  });

  it("shows (no events yet) when event list is empty", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={[]} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("(no events yet)");
    renderer.destroy();
  });

  it("navigates frames backward with k key", async () => {
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<TimelineView events={CANNED_EVENTS} />, { width: 120, height: 30 });
    await waitForVisualIdle();

    // Initially in live mode (last frame = 8)
    expect(captureCharFrame()).toContain("[live]");

    // Press k to go backward
    act(() => { mockInput.pressKey("k"); });
    await flush();
    await waitForVisualIdle();
    const after = captureCharFrame();
    // Should switch out of live mode
    expect(after).not.toContain("[live]");
    expect(after).toContain("[f");

    renderer.destroy();
  });

  it("frame indicator changes when navigating, live mode is default", async () => {
    // Verifies: starts live, navigates to a numbered frame, can navigate back to last frame
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<TimelineView events={CANNED_EVENTS} />, { width: 120, height: 30 });
    await waitForVisualIdle();

    // Initial state is live
    expect(captureCharFrame()).toContain("[live]");

    // Navigate backward (leaves live)
    act(() => { mockInput.pressKey("k"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).not.toContain("[live]");

    // Navigate forward back to last frame (j key)
    act(() => { mockInput.pressKey("j"); });
    await flush();
    await waitForVisualIdle();
    // Should be at frame 8 (the last one) but NOT live (selectedIdx > 0)
    expect(captureCharFrame()).toContain("[f8]");

    renderer.destroy();
  });

  it("navigates forward with j key", async () => {
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<TimelineView events={CANNED_EVENTS} />, { width: 120, height: 30 });
    await waitForVisualIdle();

    // Go back 1 frame from live (last=8 → becomes frame 7 = index 6 → [f7])
    act(() => { mockInput.pressKey("k"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[f7]");

    // Press j to advance to frame 8
    act(() => { mockInput.pressKey("j"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[f8]");

    renderer.destroy();
  });

  it("shows frame position info including seq", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      // Single-event list so live mode == frame 1
      <TimelineView events={[frame(42, "run.start")]} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();

    const f = captureCharFrame();
    expect(f).toContain("seq:42");
    expect(f).toContain("run.start");

    renderer.destroy();
  });

  it("shows done glyph ✓ for completed nodes", async () => {
    // Events where node-alpha finishes by frame 5
    const events = [
      frame(1, "node.start", { nodeId: "n-1", name: "task", status: "running" }),
      frame(2, "node.end", { nodeId: "n-1", name: "task", status: "done" }),
    ];
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={events} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("✓");
    renderer.destroy();
  });

  it("shows failed glyph ✗ for failed nodes", async () => {
    const events = [
      frame(1, "node.start", { nodeId: "n-1", name: "task", status: "running" }),
      frame(2, "node.fail", { nodeId: "n-1", name: "task", status: "failed" }),
    ];
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={events} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("✗");
    renderer.destroy();
  });

  it("is honest that it is inspect-only and offers NO rewind affordance", async () => {
    // The live run-event stream the monitor subscribes to does not carry
    // `_smithers_frames.frame_no`, so the timeline cannot rewind. It must not
    // advertise a rewind key (W) that would no-op or guess a frame; instead it
    // points at the real `smithers rewind` CLI.
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("inspect-only");
    expect(f).toContain("smithers rewind");
    // No "[W] rewind" affordance and no "W→frame"/"W: no frame" labels.
    expect(f).not.toContain("rewind to frame");
    expect(f).not.toContain("W→frame");
    renderer.destroy();
  });

  it("returns to live with Shift+L, exactly as the strip advertises", async () => {
    // Raw uppercase "L" goes through the REAL parser as { name: "l", shift: true }
    // (parseKeypress lowercases shifted letters), so a literal `name === "L"`
    // comparison is dead code. This locks the working binding.
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<TimelineView events={CANNED_EVENTS} />, { width: 120, height: 30 });
    await waitForVisualIdle();

    act(() => { mockInput.pressKey("k"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).not.toContain("[live]");

    act(() => { mockInput.pressKey("L"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[live]");

    renderer.destroy();
  });

  it("Shift+L works even after scrubbing forward to the last frame", async () => {
    // j to the last frame pins a NUMERIC index (not -1): before the fix there
    // was no in-mode way back to [live] at all.
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<TimelineView events={CANNED_EVENTS} />, { width: 120, height: 30 });
    await waitForVisualIdle();

    act(() => { mockInput.pressKey("k"); });
    act(() => { mockInput.pressKey("j"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[f8]");
    expect(captureCharFrame()).not.toContain("[live]");

    act(() => { mockInput.pressKey("L"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[live]");

    renderer.destroy();
  });

  it("ignores ctrl-modified chords (Ctrl-K must not scrub)", async () => {
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<TimelineView events={CANNED_EVENTS} />, { width: 120, height: 30 });
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[live]");

    // Emits the raw control byte 0x0b, parsed as { name: "k", ctrl: true }.
    act(() => { mockInput.pressKey("k", { ctrl: true }); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[live]");

    renderer.destroy();
  });

  it("unwraps the gateway run.event envelope in the frame info row", async () => {
    // The REAL wire shape: every live-streamed frame's outer event is the
    // literal "run.event"; the engine event name is nested in the payload.
    const wrapped: GatewayEventFrame = {
      type: "event",
      seq: 7,
      event: "run.event",
      payload: {
        streamId: "stream-1",
        runId: "run-1",
        seq: 7,
        event: "node.start",
        payload: { nodeId: "node-alpha", name: "fetch-data" },
      },
      stateVersion: 7,
    };
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <TimelineView events={[wrapped]} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("seq:7");
    expect(f).toContain("node.start");
    expect(f).not.toContain("run.event");
    renderer.destroy();
  });

  it("reconstructs partial node state when scrubbing to early frame", async () => {
    // Use a two-event set: only node-alpha starts at seq 1, node-beta starts at seq 2
    const twoNodeEvents = [
      frame(1, "node.start", { nodeId: "n-alpha", name: "fetch-data", status: "running" }),
      frame(2, "node.start", { nodeId: "n-beta", name: "process", status: "running" }),
    ];
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<TimelineView events={twoNodeEvents} />, { width: 120, height: 30 });
    await waitForVisualIdle();

    // Live mode shows last frame (seq 2) — both nodes visible
    expect(captureCharFrame()).toContain("fetch-data");
    expect(captureCharFrame()).toContain("process");

    // Navigate back one frame (seq 1) — only n-alpha present
    act(() => { mockInput.pressKey("k"); });
    await flush();
    await waitForVisualIdle();

    const f = captureCharFrame();
    expect(f).toContain("fetch-data");
    expect(f).not.toContain("process");

    renderer.destroy();
  });
});
