import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/events";
import type { SmithersEvent } from "../src/SmithersEvent";

function makeEvent(type: string, overrides: any = {}): SmithersEvent {
  return {
    type,
    runId: "r1",
    timestampMs: Date.now(),
    ...overrides,
  } as SmithersEvent;
}

describe("EventBus", () => {
  test("emits events to listeners", async () => {
    const bus = new EventBus({});
    const received: SmithersEvent[] = [];
    bus.on("event", (e) => received.push(e));

    await bus.emitEvent(makeEvent("RunStarted"));
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("RunStarted");
  });

  test("multiple listeners receive events", async () => {
    const bus = new EventBus({});
    const r1: SmithersEvent[] = [];
    const r2: SmithersEvent[] = [];
    bus.on("event", (e) => r1.push(e));
    bus.on("event", (e) => r2.push(e));

    await bus.emitEvent(makeEvent("RunStarted"));
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });

  test("emitEventQueued emits synchronously", async () => {
    const bus = new EventBus({});
    const received: SmithersEvent[] = [];
    bus.on("event", (e) => received.push(e));

    await bus.emitEventQueued(makeEvent("NodeStarted"));
    expect(received).toHaveLength(1);
  });

  test("constructor accepts startSeq", () => {
    const bus = new EventBus({ startSeq: 10 });
    // Should not throw; internal seq starts at 10
    expect(bus).toBeDefined();
  });

  test("flush resolves after queued events", async () => {
    const bus = new EventBus({});
    await bus.emitEventQueued(makeEvent("RunStarted"));
    await bus.emitEventQueued(makeEvent("RunFinished"));
    // flush should not throw
    await bus.flush();
  });

  test("persists events to db when provided", async () => {
    const inserted: any[] = [];
    const mockDb = {
      insertEventEffect: (row: any) => {
        inserted.push(row);
        const { Effect } = require("effect");
        return Effect.void;
      },
    };
    const bus = new EventBus({ db: mockDb });
    await bus.emitEvent(makeEvent("RunStarted"));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].type).toBe("RunStarted");
  });

  test("works without db (no persistence)", async () => {
    const bus = new EventBus({});
    // Should not throw
    await bus.emitEvent(makeEvent("RunStarted"));
    await bus.flush();
  });
});
