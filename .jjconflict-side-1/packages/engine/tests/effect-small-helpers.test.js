import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { EventBus } from "../src/events.js";
import { makeAbortError, parseAttemptMetaJson, wireAbortSignal } from "../src/effect/bridge-utils.js";
import {
    createWorkflowVersioningRuntime,
    getWorkflowPatchDecisions,
    getWorkflowVersioningRuntime,
    withWorkflowVersioningRuntime,
} from "../src/effect/versioning.js";

describe("bridge utility helpers", () => {
    test("creates abort errors, wires abort signals and parses attempt metadata", () => {
        expect(makeAbortError()._tag).toBe("TaskAborted");
        expect(makeAbortError("stop").message).toBe("stop");
        const noop = wireAbortSignal(new AbortController());
        expect(noop()).toBeUndefined();

        const source = new AbortController();
        source.abort(new Error("already stopped"));
        const target = new AbortController();
        wireAbortSignal(target, source.signal)();
        expect(target.signal.aborted).toBe(true);

        const laterSource = new AbortController();
        const laterTarget = new AbortController();
        const remove = wireAbortSignal(laterTarget, laterSource.signal);
        laterSource.abort();
        remove();
        expect(laterTarget.signal.aborted).toBe(true);

        expect(parseAttemptMetaJson(null)).toEqual({});
        expect(parseAttemptMetaJson("[1]")).toEqual({});
        expect(parseAttemptMetaJson("{")).toEqual({});
        expect(parseAttemptMetaJson('{"ok":true}')).toEqual({ ok: true });
    });
});

describe("workflow versioning helpers", () => {
    test("handles empty patch ids, snapshots and async-local scoping", async () => {
        const persisted = [];
        const records = [];
        const runtime = createWorkflowVersioningRuntime({
            baseConfig: { existing: true },
            initialDecisions: { " old ": true, ignored: "yes" },
            isNewRun: false,
            persist: async (config) => persisted.push(config),
            recordDecision: async (record) => records.push(record),
        });
        expect(runtime.resolve("   ")).toBe(false);
        expect(runtime.resolve("old")).toBe(true);
        expect(runtime.resolve("new-patch")).toBe(false);
        expect(runtime.snapshot()).toEqual({ old: true, "new-patch": false });
        await runtime.flush();
        expect(persisted[0].workflowPatches).toEqual({ old: true, "new-patch": false });
        expect(records).toEqual([{ patchId: "new-patch", decision: false }]);
        expect(getWorkflowVersioningRuntime()).toBeUndefined();
        expect(withWorkflowVersioningRuntime(runtime, () => getWorkflowVersioningRuntime())).toBe(runtime);
        expect(getWorkflowPatchDecisions({ workflowPatches: { " a ": true, b: "no", "": true } })).toEqual({ a: true });
    });
});

describe("event bus queued persistence", () => {
    test("emits and tracks events without durable persistence", async () => {
        const bus = new EventBus({});
        const seen = [];
        bus.on("event", (event) => seen.push(event));
        await Effect.runPromise(bus.emitEvent({
            type: "RunStarted",
            runId: "run-direct",
            workflowName: "workflow",
            timestampMs: Date.now(),
        }));
        expect(seen[0]).toMatchObject({
            type: "RunStarted",
            runId: "run-direct",
        });
    });

    test("stores queued persistence errors for flush", async () => {
        const bus = new EventBus({});
        bus.persist = () => Effect.fail(new Error("persist failed"));
        await expect(bus.emitEventQueued({
            type: "RunStarted",
            runId: "run",
            workflowName: "workflow",
            timestampMs: Date.now(),
        })).resolves.toBeUndefined();
        expect(bus.persistError?.message).toBe("persist failed");
        await expect(Effect.runPromise(bus.flush())).rejects.toThrow("persist failed");
    });
});
