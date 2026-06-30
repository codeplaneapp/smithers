/** @jsxImportSource @opentui/react */
import { describe, it, expect } from "bun:test";
import { renderForTest } from "./renderHelpers.tsx";
import { act } from "react";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import { LogView } from "../src/modes/LogMode.tsx";

/**
 * CI-safe rendering tests for LOGS mode.
 * No gateway, no agent CLI, no browser.
 * Uses @opentui/react testRender (headless OpenTUI renderer).
 *
 * These render the REAL presentational `LogView` (the same component production
 * mounts via `LogMode`) with injected event data — `LogMode` is a thin wrapper
 * that only reads `useRunEvents` and forwards it to `LogView`. So the view can't
 * drift from what these tests exercise.
 */

function frame(seq: number, event: string, payload?: unknown): GatewayEventFrame {
  return { type: "event", seq, event, payload, stateVersion: seq };
}

/** The REAL wrapped gateway shape: outer run.event, engine event under payload.event. */
function wrapped(seq: number, engineEvent: string, enginePayload?: unknown): GatewayEventFrame {
  return {
    type: "event",
    seq,
    event: "run.event",
    payload: { streamId: "s", seq, event: engineEvent, payload: enginePayload },
    stateVersion: seq,
  };
}

const CANNED_EVENTS: GatewayEventFrame[] = [
  frame(1, "run.event", { nodeId: "node-alpha", text: "Starting task", iteration: 0 }),
  frame(2, "tool.use", { nodeId: "node-alpha", name: "read_file", iteration: 0 }),
  frame(3, "tool.use", { nodeId: "node-alpha", name: "write_file", iteration: 0 }),
  frame(4, "tool.use", { nodeId: "node-alpha", name: "bash", iteration: 0 }),
  frame(5, "run.event", { nodeId: "node-beta", text: "Second node", iteration: 0 }),
];

describe("LogMode – terminal rendering (CI-safe, no gateway)", () => {
  it("renders event seq numbers and node IDs", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <LogView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();

    expect(frame).toContain("LOGS");
    expect(frame).toContain("[live]");
    expect(frame).toContain("node-alpha");
    expect(frame).toContain("node-beta");
    // seq numbers
    expect(frame).toContain("1");
    expect(frame).toContain("5");

    renderer.destroy();
  });

  it("shows event text content", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <LogView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();

    expect(frame).toContain("Starting task");
    expect(frame).toContain("Second node");

    renderer.destroy();
  });

  it("shows (no events) when event list is empty", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <LogView events={[]} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();
    expect(frame).toContain("(no events)");
    renderer.destroy();
  });

  it("starts in live (follow) mode", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <LogView events={CANNED_EVENTS} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();
    expect(frame).toContain("[live]");
    renderer.destroy();
  });

  it("toggles follow mode with f key", async () => {
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<LogView events={CANNED_EVENTS} />, { width: 120, height: 20 });
    await waitForVisualIdle();

    expect(captureCharFrame()).toContain("[live]");

    act(() => { mockInput.pressKey("f"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[paused]");

    act(() => { mockInput.pressKey("f"); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("[live]");

    renderer.destroy();
  });

  it("shows event count in header", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <LogView events={CANNED_EVENTS} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();
    // "5/5 events"
    expect(frame).toContain(`${CANNED_EVENTS.length}/${CANNED_EVENTS.length} events`);
    renderer.destroy();
  });

  it("walks attempts with [ and ] keys", async () => {
    const eventsWithAttempts: GatewayEventFrame[] = [
      frame(1, "run.event", { nodeId: "n-1", text: "attempt 0", iteration: 0 }),
      frame(2, "run.event", { nodeId: "n-1", text: "attempt 1", iteration: 1 }),
    ];

    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await renderForTest(<LogView events={eventsWithAttempts} />, { width: 120, height: 20 });
    await waitForVisualIdle();

    // Initial: all events shown
    expect(captureCharFrame()).toContain("2/2 events");

    // Press ] to go to first attempt (n-1:0)
    act(() => { mockInput.pressKey("]"); });
    await flush();
    await waitForVisualIdle();
    const afterNext = captureCharFrame();
    // Only 1 event matches n-1:0
    expect(afterNext).toContain("1/2 events");
    expect(afterNext).toContain("attempt:n-1:0");

    // Press [ to go back to all
    act(() => { mockInput.pressKey("["); });
    await flush();
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("2/2 events");

    renderer.destroy();
  });

  it("renders pipe separator between seq and content", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <LogView events={[frame(42, "run.event", { nodeId: "n-1", text: "hello" })]} />,
      { width: 120, height: 10 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("│");
    expect(f).toContain("hello");
    renderer.destroy();
  });

  it("unwraps REAL wrapped run.event frames for tags and text", async () => {
    const wrappedEvents: GatewayEventFrame[] = [
      wrapped(1, "run.event", { nodeId: "node-wrapped", text: "Wrapped start" }),
      wrapped(2, "agent.message", { nodeId: "node-wrapped", text: "second line" }),
    ];
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <LogView events={wrappedEvents} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    // node tag (unwrapped from the envelope) and text survive the unwrap
    expect(f).toContain("node-wrapped");
    expect(f).toContain("Wrapped start");
    expect(f).toContain("second line");
    renderer.destroy();
  });
});
