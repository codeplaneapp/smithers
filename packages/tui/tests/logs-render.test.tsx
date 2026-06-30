/** @jsxImportSource @opentui/react */
import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import {
  extractNodeId,
  extractEventText,
  classifyToolSideEffect,
  badgeLabel,
  badgeColor,
  extractAttemptKeys,
  filterEventsByAttempt,
} from "../src/modes/logUtils.ts";

/**
 * CI-safe rendering tests for LOGS mode logic.
 * No gateway, no agent CLI, no browser.
 * Uses @opentui/react testRender (headless OpenTUI renderer).
 *
 * Tests a standalone TestLogView that replicates LogMode rendering
 * with injected event data (no useRunEvents / provider required).
 */

function frame(seq: number, event: string, payload?: unknown): GatewayEventFrame {
  return { type: "event", seq, event, payload, stateVersion: seq };
}

const CANNED_EVENTS: GatewayEventFrame[] = [
  frame(1, "run.event", { nodeId: "node-alpha", text: "Starting task", iteration: 0 }),
  frame(2, "tool.use", { nodeId: "node-alpha", name: "read_file", iteration: 0 }),
  frame(3, "tool.use", { nodeId: "node-alpha", name: "write_file", iteration: 0 }),
  frame(4, "tool.use", { nodeId: "node-alpha", name: "bash", iteration: 0 }),
  frame(5, "run.event", { nodeId: "node-beta", text: "Second node", iteration: 0 }),
];

// Minimal log view – same visual logic as LogMode but takes events as a prop.
function TestLogView({
  events,
  follow: initialFollow = true,
}: {
  events: GatewayEventFrame[];
  follow?: boolean;
}) {
  const [follow, setFollow] = useState(initialFollow);
  const [attemptIdx, setAttemptIdx] = useState(-1);

  const attempts = extractAttemptKeys(events);
  const filteredEvents =
    attemptIdx >= 0 && attempts.length > 0 && attempts[attemptIdx]
      ? filterEventsByAttempt(events, attempts[attemptIdx]!)
      : events;

  useKeyboard((e) => {
    if (e.name === "f") setFollow((prev) => !prev);
    else if (e.name === "[") setAttemptIdx((prev) => Math.max(-1, prev - 1));
    else if (e.name === "]")
      setAttemptIdx((prev) => Math.min(Math.max(0, attempts.length - 1), prev + 1));
  });

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={1} flexDirection="row">
        <text fg="#555555">{"  LOGS "}</text>
        <text fg={follow ? "#00d787" : "#ffaf00"}>{follow ? "[live]" : "[paused]"}</text>
        <text fg="#555555">{`  ${filteredEvents.length}/${events.length} events`}</text>
        <text fg="#555555">{"  [f] follow  [[] prev  []] next"}</text>
        {attemptIdx >= 0 && attempts[attemptIdx] ? (
          <text fg="#888888">{`  attempt:${attempts[attemptIdx]}`}</text>
        ) : null}
      </box>
      <scrollbox width="100%" flexGrow={1} scrollY stickyScroll={follow} stickyStart="bottom">
        {filteredEvents.length === 0 ? (
          <text fg="#444444">{"  (no events)"}</text>
        ) : (
          filteredEvents.map((ev) => {
            const nodeId = extractNodeId(ev.payload);
            const effect = classifyToolSideEffect(ev.event, ev.payload);
            const text = extractEventText(ev.event, ev.payload);
            const tag = nodeId ? nodeId.slice(0, 12) : "·";
            const seqStr = String(ev.seq).padStart(4, " ");
            const badge = badgeLabel(effect);
            const bColor = badgeColor(effect);

            return (
              <box key={ev.seq} width="100%" height={1} flexDirection="row">
                <text fg="#444444">{`${seqStr} `}</text>
                <text fg="#555555">{`[${tag}]`}</text>
                <text fg="#444444">{" │ "}</text>
                {badge ? <text fg={bColor}>{`${badge} `}</text> : null}
                <text fg="#cccccc" wrapMode="char">{text}</text>
              </box>
            );
          })
        )}
      </scrollbox>
    </box>
  );
}

describe("LogMode – terminal rendering (CI-safe, no gateway)", () => {
  it("renders event seq numbers and node IDs", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await testRender(
      <TestLogView events={CANNED_EVENTS} />,
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

  it("renders tool-call badges", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await testRender(
      <TestLogView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();

    // read badge for read_file, write for write_file, shell for bash
    expect(frame).toContain("[read]");
    expect(frame).toContain("[write]");
    expect(frame).toContain("[shell]");

    renderer.destroy();
  });

  it("shows event text content", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await testRender(
      <TestLogView events={CANNED_EVENTS} />,
      { width: 120, height: 30 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();

    expect(frame).toContain("Starting task");
    expect(frame).toContain("Second node");

    renderer.destroy();
  });

  it("shows (no events) when event list is empty", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await testRender(
      <TestLogView events={[]} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();
    expect(frame).toContain("(no events)");
    renderer.destroy();
  });

  it("starts in live (follow) mode", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await testRender(
      <TestLogView events={CANNED_EVENTS} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    const frame = captureCharFrame();
    expect(frame).toContain("[live]");
    renderer.destroy();
  });

  it("toggles follow mode with f key", async () => {
    const { waitForVisualIdle, captureCharFrame, mockInput, renderer, flush } =
      await testRender(<TestLogView events={CANNED_EVENTS} />, { width: 120, height: 20 });
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
    const { waitForVisualIdle, captureCharFrame, renderer } = await testRender(
      <TestLogView events={CANNED_EVENTS} />,
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
      await testRender(<TestLogView events={eventsWithAttempts} />, { width: 120, height: 20 });
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
    const { waitForVisualIdle, captureCharFrame, renderer } = await testRender(
      <TestLogView events={[frame(42, "run.event", { nodeId: "n-1", text: "hello" })]} />,
      { width: 120, height: 10 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("│");
    expect(f).toContain("hello");
    renderer.destroy();
  });
});
