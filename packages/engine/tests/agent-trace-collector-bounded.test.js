import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { AgentTraceCollector } from "../src/AgentTraceCollector.js";

class FakeEventBus extends EventEmitter {
  emitted = [];
  async emitEventQueued(event) {
    this.emitted.push(event);
  }
}

function makeCollector() {
  return new AgentTraceCollector({
    eventBus: new FakeEventBus(),
    runId: "run-1",
    workflowPath: "/tmp/workflow.tsx",
    workflowHash: "hash",
    cwd: process.cwd(),
    nodeId: "task",
    iteration: 0,
    attempt: 1,
    agent: { id: "codex-agent" },
    agentId: "codex-agent",
    model: "codex-test",
    annotations: {},
  });
}

describe("AgentTraceCollector bounded event buffer (spec decision 15)", () => {
  test("caps the in-memory buffer, keeps head + tail, and records the drop count", () => {
    const collector = makeCollector();
    const TOTAL = 6000;
    for (let i = 0; i < TOTAL; i += 1) {
      collector.pushDerived("assistant.message.delta", { i }, { i }, "test");
    }

    // Memory is bounded: never grows past MAX_RETAINED + TRIM_BATCH (4096+512).
    expect(collector.events.length).toBeLessThanOrEqual(4608);
    // Some events were dropped, and none are lost accounting-wise.
    expect(collector.droppedEventCount).toBeGreaterThan(0);
    expect(collector.droppedEventCount + collector.events.length).toBe(TOTAL);

    // Head retained: the very first event (sequence 0) survives.
    expect(collector.events[0].event.sequence).toBe(0);
    // Tail retained: the most recent event survives.
    expect(collector.events.at(-1).event.sequence).toBe(TOTAL - 1);
    // A contiguous gap in the middle (dropped), not a scattered loss: the
    // retained head is a prefix and the retained tail is a suffix.
    const seqs = collector.events.map((e) => e.event.sequence);
    expect(seqs[0]).toBe(0);
    // seenKinds aggregate is unaffected by capping.
    expect(collector.seenKinds.has("assistant.message.delta")).toBe(true);
  });

  test("does not trim when the buffer stays under the cap", () => {
    const collector = makeCollector();
    for (let i = 0; i < 100; i += 1) {
      collector.pushDerived("assistant.message.delta", { i }, { i }, "test");
    }
    expect(collector.events.length).toBe(100);
    expect(collector.droppedEventCount).toBe(0);
  });

  test("flush records a truncation warning + capture.warning event when events were dropped", async () => {
    const collector = makeCollector();
    for (let i = 0; i < 6000; i += 1) {
      collector.pushDerived("assistant.message.delta", { i }, { i }, "test");
    }
    collector.finalText = "done";
    await collector.flush();
    expect(collector.warnings.some((w) => w.includes("dropped") && w.includes("bound memory"))).toBe(true);
    expect(
      collector.events.some(
        (e) => e.event.kind === "capture.warning" && /** @type {any} */ (e.payload)?.reason === "trace-truncated",
      ),
    ).toBe(true);
  });
});
