import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeWorkflowSession } from "../src/makeWorkflowSession.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function makeEventDescriptor(overrides = {}) {
  return {
    nodeId: "wait-for-event",
    iteration: 0,
    ordinal: 0,
    outputTable: null,
    outputTableName: "",
    continueOnFail: false,
    retries: 0,
    retryPolicy: undefined,
    meta: {
      __waitForEvent: true,
      __eventName: "expected-event",
      ...overrides.meta,
    },
    ...overrides,
  };
}

function makeGraph(descriptor) {
  return {
    xml: el("smithers:workflow", {}, [
      el("smithers:task", { id: descriptor.nodeId }),
    ]),
    tasks: [descriptor],
    mountedTaskIds: new Set([`${descriptor.nodeId}::${descriptor.iteration}`]),
  };
}

describe("makeWorkflowSession event and signal delivery", () => {
  test("signalReceived uses the same event-name matching as eventReceived", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeEventDescriptor({
      meta: {
        __waitForEvent: true,
        __eventName: "expected-event",
        __signalName: "legacy-signal",
      },
    });

    const initial = Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    expect(initial).toEqual({
      _tag: "Wait",
      reason: { _tag: "Event", eventName: "expected-event" },
    });

    const afterLegacySignal = Effect.runSync(
      session.signalReceived("legacy-signal", { ignored: true }),
    );
    expect(afterLegacySignal).toEqual({
      _tag: "Wait",
      reason: { _tag: "Event", eventName: "expected-event" },
    });

    const afterExpectedSignal = Effect.runSync(
      session.signalReceived("expected-event", { ok: true }),
    );
    expect(afterExpectedSignal).toEqual({
      _tag: "Finished",
      result: {
        runId: expect.any(String),
        status: "finished",
        output: { ok: true },
      },
    });
  });
});
