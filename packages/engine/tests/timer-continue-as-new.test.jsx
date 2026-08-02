/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runWorkflow, Timer, Workflow } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { buildStateKey } from "@smthrs/scheduler/buildStateKey";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { resolveDeferredTaskStateBridge } from "../src/effect/deferred-state-bridge.js";

const DURATION_MS = 10_000;

// A duration-timer descriptor matching what the engine renders for
// `<Timer id="hold" duration="10s" />` — the bridge only reads these fields.
function timerDesc() {
  return {
    nodeId: "hold",
    ordinal: 0,
    iteration: 0,
    outputTable: null,
    outputTableName: "",
    outputSchema: null,
    needsApproval: false,
    waitAsync: false,
    timeoutMs: null,
    label: "hold",
    meta: { __timer: true, __timerType: "duration", __timerDuration: "10s" },
    continueOnFail: false,
  };
}

// Bridge-only event sink: the timer path just emits through
// emitEventWithPersist, so a fake avoids setting up a log directory.
function makeEventBus() {
  const events = [];
  return {
    events,
    emitEventWithPersist: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    emitEventQueued: async (event) => {
      events.push(event);
    },
    flush: () => Effect.void,
  };
}

async function insertRun(adapter, runId) {
  await Effect.runPromise(
    adapter.insertRun({
      runId,
      workflowName: "timer-can",
      workflowHash: "hash",
      status: "running",
      createdAtMs: nowMs(),
    }),
  );
}

describe("timer continue-as-new handoff", () => {
  test("duration-timer anchor survives a continue-as-new handoff at the DB/bridge level", async () => {
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const workflow = smithers(() => (
      <Workflow name="timer-can">
        <Timer id="hold" duration="10s" />
      </Workflow>
    ));

    // 1) Parent run parks on the timer; capture its anchored deadline. The start
    //    anchor (createdAtMs) is what continue-as-new carries forward.
    const parentRunId = "timer-can-parent";
    const parent = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: parentRunId }));
    expect(parent.status).toBe("waiting-timer");
    const parentAttempts = await Effect.runPromise(adapter.listAttempts(parentRunId, "hold", 0));
    const parentTimer = JSON.parse(parentAttempts[0].metaJson).timer;
    const parentStart = parentTimer.createdAtMs;
    const parentFiresAtMs = parentTimer.firesAtMs;
    expect(parentFiresAtMs).toBe(parentStart + DURATION_MS);

    // 2) Continue-as-new hands the START anchor to the child via timerStarts. Boot
    //    the child at the DB/bridge level with that carried anchor — exactly what
    //    the engine's reconcileTimerWait now threads as `carriedTimerStarts` into
    //    resolveDeferredTaskStateBridge.
    const childRunId = "timer-can-child";
    await insertRun(adapter, childRunId);
    const carried = new Map([[buildStateKey("hold", 0), parentStart]]);
    // A real delay so the child boots strictly after the parent: proves the child
    // does NOT restart the full duration from its own boot time.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const childBoot = nowMs();
    expect(childBoot).toBeGreaterThan(parentStart);
    const resolved = await resolveDeferredTaskStateBridge(
      adapter,
      db,
      childRunId,
      timerDesc(),
      makeEventBus(),
      undefined,
      carried,
    );
    expect(resolved).toEqual({ handled: true, state: "waiting-timer" });
    const childAttempts = await Effect.runPromise(adapter.listAttempts(childRunId, "hold", 0));
    const childTimer = JSON.parse(childAttempts[0].metaJson).timer;
    // (a) The carried deadline is preserved: firesAtMs equals the parent's
    //     original deadline, NOT childBoot + full duration.
    expect(childTimer.firesAtMs).toBe(parentFiresAtMs);
    expect(childTimer.firesAtMs).toBeLessThan(childBoot + DURATION_MS);

    // (b) With no injectable clock, model "the carried deadline has already passed"
    //     by carrying an anchor far enough in the past that start + duration < now.
    //     The bridge must then fire immediately instead of busy-spinning on
    //     waiting-timer.
    const pastRunId = "timer-can-past";
    await insertRun(adapter, pastRunId);
    const pastAnchor = nowMs() - DURATION_MS - 1_000;
    const pastBus = makeEventBus();
    const firedResolved = await resolveDeferredTaskStateBridge(
      adapter,
      db,
      pastRunId,
      timerDesc(),
      pastBus,
      undefined,
      new Map([[buildStateKey("hold", 0), pastAnchor]]),
    );
    expect(firedResolved).toEqual({ handled: true, state: "finished" });
    expect(pastBus.events.some((event) => event.type === "TimerFired")).toBe(true);
    const pastAttempts = await Effect.runPromise(adapter.listAttempts(pastRunId, "hold", 0));
    expect(pastAttempts[0].state).toBe("finished");

    cleanup();
  });
});
