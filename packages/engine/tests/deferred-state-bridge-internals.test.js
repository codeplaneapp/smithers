import { describe, expect, test } from "bun:test";
import React from "react";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { buildHumanRequestId } from "../src/human-requests.js";
import {
    __deferredStateBridgeInternals as I,
    isBridgeManagedTimerTask,
    isBridgeManagedWaitForEventTask,
} from "../src/effect/deferred-state-bridge.js";
import { bridgeWaitForEventResolve } from "../src/effect/durable-deferred-bridge.js";

function makeEventBus() {
    const events = [];
    return {
        events,
        emitEventWithPersist: (event) => Effect.sync(() => {
            events.push(event);
        }),
        emitEventQueued: async (event) => {
            events.push(event);
        },
        flush: () => Effect.void,
    };
}

function makeHarness() {
    const api = createTestSmithers(outputSchemas);
    ensureSmithersTables(api.db);
    return {
        ...api,
        adapter: new SmithersDb(api.db),
    };
}

function makeDesc(tables, overrides = {}) {
    return {
        nodeId: "node",
        ordinal: 0,
        iteration: 0,
        outputTable: tables.outputA,
        outputTableName: "output_a",
        outputSchema: outputSchemas.outputA,
        needsApproval: false,
        approvalMode: "gate",
        approvalOnDeny: "fail",
        approvalOptions: [],
        approvalAllowedScopes: [],
        approvalAllowedUsers: [],
        approvalAutoApprove: null,
        waitAsync: false,
        timeoutMs: null,
        label: "Node label",
        meta: {},
        continueOnFail: false,
        ...overrides,
    };
}

async function insertAttempt(adapter, runId, desc, state, overrides = {}) {
    await Effect.runPromise(adapter.insertAttempt({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: overrides.attempt ?? 1,
        state,
        startedAtMs: overrides.startedAtMs ?? Date.now() - 100,
        finishedAtMs: overrides.finishedAtMs ?? null,
        errorJson: overrides.errorJson ?? null,
        jjPointer: null,
        jjCwd: null,
        cached: false,
        metaJson: overrides.metaJson ?? null,
        responseText: null,
    }));
}

async function insertRun(adapter, runId, workflowName = "wf") {
    await Effect.runPromise(adapter.insertRun({
        runId,
        workflowName,
        workflowHash: "hash",
        status: "running",
        createdAtMs: Date.now(),
    }));
}

describe("deferred state bridge pure helpers", () => {
    test("renders human prompts and approval request metadata", () => {
        expect(I.buildApprovalRequestJson({
            approvalMode: "select",
            waitAsync: true,
            label: "Pick one",
            meta: { requestSummary: "summary" },
            approvalOptions: [{ key: "a" }],
            approvalAllowedScopes: ["team"],
            approvalAllowedUsers: ["alice"],
            approvalAutoApprove: { after: 1 },
        })).toContain('"mode":"select"');
        expect(I.buildHumanRequestSchemaJson({})).toBeNull();
        expect(I.renderHumanPromptToText(null)).toBe("");
        expect(I.renderHumanPromptToText("plain")).toBe("plain");
        expect(I.renderHumanPromptToText(7)).toBe("7");
        expect(I.renderHumanPromptToText(React.createElement("strong", null, "Bold"))).toContain("Bold");
        expect(I.renderHumanPromptToText(["a", React.createElement("span", { key: "s" }, "b")])).toContain("<span>b</span>");
        expect(() => I.renderHumanPromptToText({ bad: true })).toThrow("MDX preload");
        expect(I.renderHumanPromptToText({ toString: () => "custom prompt" })).toBe("custom prompt");
        expect(I.getHumanTaskPrompt({ prompt: "  " }, "fallback")).toBe("fallback");
        expect(I.getHumanTaskPrompt({ prompt: "Use this" }, "fallback")).toBe("Use this");
    });

    test("parses timer, wait-event and approval helper values", async () => {
        expect(I.parseAttemptErrorCode(null)).toBeNull();
        expect(I.parseAttemptErrorCode("{")).toBeNull();
        expect(I.parseAttemptErrorCode(JSON.stringify({ code: "HUMAN_TASK_INVALID_JSON" }))).toBe("HUMAN_TASK_INVALID_JSON");
        expect(I.defaultAutoApprovalDecision({ approvalMode: "select", approvalOptions: [] })).toBeNull();
        expect(I.defaultAutoApprovalDecision({ approvalMode: "select", approvalOptions: [{ key: "one" }] })).toEqual({
            selected: "one",
            notes: "Automatically selected",
        });
        expect(I.defaultAutoApprovalDecision({ approvalMode: "rank", approvalOptions: [{ key: "a" }, { key: "b" }] })).toEqual({
            ranked: ["a", "b"],
            notes: "Automatically ranked",
        });

        const fakeAdapter = {
            getRun: () => Effect.succeed({ workflowName: "wf" }),
            listApprovalHistoryForNode: () => Effect.succeed([
                { runId: "current", status: "approved", autoApproved: false },
                { runId: "other-auto", status: "approved", autoApproved: true },
                { runId: "one", status: "approved", autoApproved: false },
                { runId: "two", status: "approved", autoApproved: false },
            ]),
        };
        expect(await I.shouldAutoApprove(fakeAdapter, "run", { approvalAutoApprove: null })).toBe(false);
        expect(await I.shouldAutoApprove(fakeAdapter, "run", { approvalAutoApprove: { revertOnMet: true } })).toBe(false);
        expect(await I.shouldAutoApprove(fakeAdapter, "run", { approvalAutoApprove: { conditionMet: false } })).toBe(false);
        expect(await I.shouldAutoApprove(fakeAdapter, "run", { approvalAutoApprove: { after: -1 } })).toBe(false);
        // Non-finite thresholds are clamped to "never auto-approve" rather than
        // falling through to the after=0 immediate-approve path or looping.
        expect(await I.shouldAutoApprove(fakeAdapter, "run", { approvalAutoApprove: { after: Number.NaN } })).toBe(false);
        expect(await I.shouldAutoApprove(fakeAdapter, "run", { approvalAutoApprove: { after: Number.POSITIVE_INFINITY } })).toBe(false);
        expect(await I.shouldAutoApprove(fakeAdapter, "run", { approvalAutoApprove: { after: 0 } })).toBe(true);
        expect(await I.shouldAutoApprove({
            getRun: () => Effect.succeed(null),
        }, "run", { nodeId: "node", approvalAutoApprove: { after: 1 } })).toBe(false);
        expect(await I.shouldAutoApprove(fakeAdapter, "current", { nodeId: "node", approvalAutoApprove: { after: 2 } })).toBe(true);
        expect(await I.shouldAutoApprove({
            getRun: () => Effect.succeed({ workflowName: "wf" }),
            listApprovalHistoryForNode: () => Effect.succeed([{ runId: "old", status: "denied", autoApproved: false }]),
        }, "run", { nodeId: "node", approvalAutoApprove: { after: 1 } })).toBe(false);
        expect(await I.shouldAutoApprove({
            getRun: () => Effect.succeed({ workflowName: "wf" }),
            listApprovalHistoryForNode: () => Effect.succeed([
                { runId: "old-approved", status: "approved", autoApproved: false },
                { runId: "old-denied", status: "denied", autoApproved: false },
            ]),
        }, "run", { nodeId: "node", approvalAutoApprove: { after: 2 } })).toBe(false);
        expect(await I.shouldAutoApprove({
            getRun: () => Effect.succeed({ workflowName: "wf" }),
            listApprovalHistoryForNode: () => Effect.succeed([
                { runId: "old-requested", status: "requested", autoApproved: false },
            ]),
        }, "run", { nodeId: "node", approvalAutoApprove: { after: 1 } })).toBe(false);

        expect(isBridgeManagedTimerTask({ meta: { __timer: true } })).toBe(true);
        expect(isBridgeManagedWaitForEventTask({ meta: { __waitForEvent: true } })).toBe(true);
        expect(I.parseTimerType({ meta: { __timerType: "absolute" } })).toBe("absolute");
        expect(() => I.parseWaitForEventSignalName({ nodeId: "wait", meta: {} })).toThrow("missing event metadata");
        expect(I.parseWaitForEventSignalName({ meta: { __eventName: " signal " } })).toBe("signal");
        expect(I.parseWaitForEventCorrelationId({ meta: { __correlationId: " c " } })).toBe("c");
        expect(I.parseWaitForEventCorrelationId({ meta: { __correlationId: "" } })).toBeUndefined();
        expect(I.parseWaitForEventOnTimeout({ meta: { __onTimeout: "continue" } })).toBe("continue");
        expect(I.parseWaitForEventOnTimeout({ meta: { __onTimeout: "skip" } })).toBe("skip");
        expect(I.parseWaitForEventOnTimeout({ meta: { __onTimeout: "other" } })).toBe("fail");
        expect(I.parseOptionalFiniteNumber(null)).toBeUndefined();
        expect(I.parseOptionalFiniteNumber("")).toBeUndefined();
        expect(I.parseOptionalFiniteNumber("12")).toBe(12);
        expect(I.parseOptionalFiniteNumber("nope")).toBeUndefined();
    });

    test("builds and parses deferred snapshots and validates output payloads", () => {
        const waitDesc = {
            nodeId: "wait",
            timeoutMs: 50,
            waitAsync: true,
            meta: {
                __eventName: "ready",
                __correlationId: "job-1",
                __onTimeout: "skip",
            },
        };
        const snapshot = I.buildWaitForEventSnapshot(waitDesc, 100);
        expect(snapshot).toMatchObject({
            signalName: "ready",
            correlationId: "job-1",
            onTimeout: "skip",
            timeoutMs: 50,
            waitAsync: true,
            startedAtMs: 100,
        });
        expect(I.parseWaitForEventSnapshot(null)).toBeNull();
        expect(I.parseWaitForEventSnapshot(JSON.stringify({ waitForEvent: [] }))).toBeNull();
        expect(I.parseWaitForEventSnapshot(JSON.stringify({ waitForEvent: { signalName: "", startedAtMs: 1 } }))).toBeNull();
        expect(I.parseWaitForEventSnapshot(JSON.stringify({
            waitForEvent: {
                signalName: "ready",
                correlationId: "job-1",
                onTimeout: "continue",
                timeoutMs: "25",
                waitAsync: true,
                startedAtMs: 10,
                resolvedSignalSeq: "2",
                receivedAtMs: "30",
                timedOutAtMs: "40",
            },
        }))).toMatchObject({
            signalName: "ready",
            correlationId: "job-1",
            onTimeout: "continue",
            timeoutMs: 25,
            resolvedSignalSeq: 2,
            receivedAtMs: 30,
            timedOutAtMs: 40,
        });
        expect(I.buildWaitForEventAttemptMeta(snapshot).waitForEvent.signalName).toBe("ready");
        expect(I.shouldClearAsyncWaitMetric({ waitAsync: true, resolvedSignalSeq: undefined })).toBe(true);
        expect(I.shouldClearAsyncWaitMetric({ waitAsync: true, resolvedSignalSeq: 1 })).toBe(false);

        expect(I.parseTimerDurationMs("1.5s", "timer")).toBe(1500);
        expect(I.parseTimerDurationMs("2d", "timer")).toBe(172_800_000);
        expect(() => I.parseTimerDurationMs("soon", "timer")).toThrow("invalid duration");
        expect(() => I.parseTimerDurationMs(`${"9".repeat(400)}d`, "timer")).toThrow("not valid");
        expect(() => I.parseTimerUntilMs("never", "timer")).toThrow("invalid \"until\"");
        expect(I.parseTimerUntilMs("2026-01-01T00:00:00.000Z", "timer")).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
        expect(() => I.buildTimerSnapshot({ nodeId: "timer", meta: { __timer: true } }, 10)).toThrow("missing duration");
        expect(() => I.buildTimerSnapshot({ nodeId: "timer", meta: { __timer: true, __timerType: "absolute" } }, 10)).toThrow("missing until");
        expect(I.buildTimerSnapshot({ nodeId: "timer", meta: { __timer: true, __timerDuration: "5ms" } }, 10)).toMatchObject({
            timerId: "timer",
            timerType: "duration",
            firesAtMs: 15,
        });
        expect(I.buildTimerSnapshot({
            nodeId: "timer",
            meta: { __timer: true, __timerType: "absolute", __timerUntil: "2026-01-01T00:00:00.000Z" },
        }, 10).firesAtMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
        expect(I.parseTimerSnapshot(null)).toBeNull();
        expect(I.parseTimerSnapshot(JSON.stringify({ timer: [] }))).toBeNull();
        expect(I.parseTimerSnapshot(JSON.stringify({ timer: { timerId: "", createdAtMs: 1, firesAtMs: 2 } }))).toBeNull();
        expect(I.parseTimerSnapshot(JSON.stringify({
            timer: {
                timerId: "timer",
                timerType: "absolute",
                createdAtMs: 1,
                firesAtMs: 2,
                firedAtMs: "3",
                duration: "1ms",
                until: "later",
            },
        }))).toMatchObject({
            timerId: "timer",
            timerType: "absolute",
            firedAtMs: 3,
            duration: "1ms",
            until: "later",
        });
        expect(I.buildTimerAttemptMeta({ timerId: "timer", timerType: "duration", createdAtMs: 1, firesAtMs: 2 }).timer.firedAtMs).toBeNull();

        const { tables, cleanup } = makeHarness();
        try {
            expect(() => I.validateDeferredOutputPayload({ nodeId: "missing", iteration: 0 }, "run", {})).toThrow("missing a resolved output table");
            expect(() => I.validateDeferredOutputPayload({
                nodeId: "node",
                iteration: 0,
                outputTable: tables.outputA,
                outputTableName: "output_a",
                outputSchema: z.object({ value: z.string() }),
            }, "run", { value: 1 })).toThrow();
            expect(I.validateDeferredOutputPayload({
                nodeId: "node",
                iteration: 0,
                outputTable: tables.outputA,
                outputTableName: "output_a",
                outputSchema: outputSchemas.outputA,
            }, "run", {
                runId: "shadow",
                nodeId: "shadow",
                iteration: 99,
                value: 3,
            })).toMatchObject({
                runId: "run",
                nodeId: "node",
                iteration: 0,
                value: 3,
            });
        }
        finally {
            cleanup();
        }
    });
});

describe("deferred state bridge state transitions", () => {
    test("creates immediate timers and mirrors terminal timer attempts", async () => {
        const { adapter, tables, cleanup } = makeHarness();
        try {
            const eventBus = makeEventBus();
            const immediate = makeDesc(tables, {
                nodeId: "timer-now",
                outputTableName: "output_a",
                meta: { __timer: true, __timerDuration: "0ms" },
            });
            expect(await I.resolveTimerTaskStateBridge(adapter, "timer-run", immediate, eventBus)).toEqual({
                handled: true,
                state: "finished",
            });
            expect(eventBus.events.map((event) => event.type)).toEqual(["TimerCreated", "TimerFired", "NodeFinished"]);

            for (const [state, expected] of [
                ["finished", "finished"],
                ["cancelled", "skipped"],
                ["failed", "failed"],
            ]) {
                const desc = makeDesc(tables, {
                    nodeId: `timer-${state}`,
                    meta: { __timer: true, __timerDuration: "1ms" },
                });
                await insertAttempt(adapter, `run-${state}`, desc, state, {
                    metaJson: JSON.stringify(I.buildTimerAttemptMeta({
                        timerId: desc.nodeId,
                        timerType: "duration",
                        duration: "1ms",
                        createdAtMs: Date.now() - 10,
                        firesAtMs: Date.now() - 5,
                    })),
                });
                expect(await I.resolveTimerTaskStateBridge(adapter, `run-${state}`, desc, makeEventBus())).toEqual({
                    handled: true,
                    state: expected,
                });
            }
            const unknown = makeDesc(tables, {
                nodeId: "timer-running",
                meta: { __timer: true, __timerDuration: "1ms" },
            });
            await insertAttempt(adapter, "run-running", unknown, "in-progress");
            expect(await I.resolveTimerTaskStateBridge(adapter, "run-running", unknown, makeEventBus())).toEqual({
                handled: false,
            });
        }
        finally {
            cleanup();
        }
    });

    test("resumes durable timers: still-future stays waiting, elapsed-during-downtime fires", async () => {
        const { adapter, tables, cleanup } = makeHarness();
        try {
            // A timer that was persisted as waiting-timer in a prior process and whose
            // deadline is still in the future must stay waiting on resume (no re-fire).
            const futureBus = makeEventBus();
            const futureDesc = makeDesc(tables, {
                nodeId: "timer-future",
                meta: { __timer: true, __timerDuration: "1h" },
            });
            await insertAttempt(adapter, "run-future", futureDesc, "waiting-timer", {
                metaJson: JSON.stringify(I.buildTimerAttemptMeta({
                    timerId: futureDesc.nodeId,
                    timerType: "duration",
                    duration: "1h",
                    createdAtMs: Date.now() - 1_000,
                    firesAtMs: Date.now() + 3_600_000,
                })),
            });
            expect(await I.resolveTimerTaskStateBridge(adapter, "run-future", futureDesc, futureBus)).toEqual({
                handled: true,
                state: "waiting-timer",
            });
            // No TimerFired/NodeFinished emitted while still waiting.
            expect(futureBus.events.map((event) => event.type)).toEqual([]);

            // A timer whose deadline elapsed while the process was down must fire on
            // resume (finished + TimerFired + NodeFinished).
            const elapsedBus = makeEventBus();
            const elapsedDesc = makeDesc(tables, {
                nodeId: "timer-elapsed",
                meta: { __timer: true, __timerDuration: "1ms" },
            });
            await insertAttempt(adapter, "run-elapsed", elapsedDesc, "waiting-timer", {
                metaJson: JSON.stringify(I.buildTimerAttemptMeta({
                    timerId: elapsedDesc.nodeId,
                    timerType: "duration",
                    duration: "1ms",
                    createdAtMs: Date.now() - 60_000,
                    firesAtMs: Date.now() - 30_000,
                })),
            });
            expect(await I.resolveTimerTaskStateBridge(adapter, "run-elapsed", elapsedDesc, elapsedBus)).toEqual({
                handled: true,
                state: "finished",
            });
            expect(elapsedBus.events.map((event) => event.type)).toEqual(["TimerFired", "NodeFinished"]);
            const firedEvent = elapsedBus.events.find((event) => event.type === "TimerFired");
            expect(firedEvent?.timerId).toBe("timer-elapsed");
            // The recorded delay reflects the downtime overshoot (fired well after firesAtMs).
            expect(firedEvent?.delayMs).toBeGreaterThanOrEqual(30_000);

            // The persisted attempt is now finished (durable, exactly-once on next resume).
            const attempts = await Effect.runPromise(adapter.listAttempts("run-elapsed", "timer-elapsed", 0));
            expect(attempts[0]?.state).toBe("finished");
        }
        finally {
            cleanup();
        }
    });

    test("uses the attempt start time when waiting timer metadata is corrupt", async () => {
        const { adapter, tables, cleanup } = makeHarness();
        try {
            const eventBus = makeEventBus();
            const desc = makeDesc(tables, {
                nodeId: "timer-corrupt-meta",
                meta: { __timer: true, __timerDuration: "1h" },
            });
            await insertAttempt(adapter, "run-corrupt-meta", desc, "waiting-timer", {
                startedAtMs: Date.now() - 2 * 60 * 60 * 1_000,
                metaJson: "legacy timer metadata",
            });

            expect(await I.resolveTimerTaskStateBridge(adapter, "run-corrupt-meta", desc, eventBus)).toEqual({
                handled: true,
                state: "finished",
            });
            expect(eventBus.events.map((event) => event.type)).toEqual(["TimerFired", "NodeFinished"]);

            const attempts = await Effect.runPromise(adapter.listAttempts("run-corrupt-meta", desc.nodeId, 0));
            expect(attempts[0]?.state).toBe("finished");
        }
        finally {
            cleanup();
        }
    });

    test("fails, finishes and times out wait-for-event attempts", async () => {
        const { adapter, db, tables, cleanup } = makeHarness();
        try {
            const baseSnapshot = {
                signalName: "ready",
                correlationId: null,
                onTimeout: "fail",
                timeoutMs: 1,
                waitAsync: true,
                startedAtMs: Date.now() - 100,
            };
            const desc = makeDesc(tables, {
                nodeId: "wait-fail",
                meta: { __waitForEvent: true, __eventName: "ready" },
            });
            const emitted = [];
            await insertAttempt(adapter, "wait-run", desc, "waiting-event");
            expect(await I.failWaitForEventTaskBridge(adapter, "wait-run", desc, 1, new Error("bad"), baseSnapshot, (state) => {
                emitted.push(state);
            })).toEqual({ handled: true, state: "failed" });
            expect(emitted).toEqual(["failed"]);

            const finishDesc = makeDesc(tables, {
                nodeId: "wait-finish",
                meta: { __waitForEvent: true, __eventName: "ready" },
            });
            await insertAttempt(adapter, "finish-run", finishDesc, "waiting-event");
            expect(await I.finishWaitForEventTaskBridge(adapter, "finish-run", finishDesc, 1, { value: 5 }, {
                ...baseSnapshot,
                resolvedSignalSeq: 1,
            })).toEqual({ handled: true, state: "finished" });
            const clearMetricDesc = makeDesc(tables, {
                nodeId: "wait-finish-clear",
                meta: { __waitForEvent: true, __eventName: "ready" },
            });
            await insertAttempt(adapter, "finish-clear-run", clearMetricDesc, "waiting-event");
            expect(await I.finishWaitForEventTaskBridge(adapter, "finish-clear-run", clearMetricDesc, 1, { value: 6 }, baseSnapshot)).toEqual({
                handled: true,
                state: "finished",
            });
            const finishRows = await db.select().from(tables.outputA);
            expect(finishRows.some((row) => row.runId === "finish-run" && row.value === 5)).toBe(true);

            const skipDesc = makeDesc(tables, {
                nodeId: "wait-skip",
                meta: { __waitForEvent: true, __eventName: "ready", __onTimeout: "skip" },
            });
            await insertAttempt(adapter, "skip-run", skipDesc, "waiting-event");
            const skipped = [];
            expect(await I.resolveWaitForEventTimeoutBridge(adapter, "skip-run", skipDesc, 1, {
                ...baseSnapshot,
                onTimeout: "skip",
            }, (state) => skipped.push(state))).toEqual({ handled: true, state: "skipped" });
            expect(skipped).toEqual(["skipped"]);

            const continueDesc = makeDesc(tables, {
                nodeId: "wait-continue",
                meta: { __waitForEvent: true, __eventName: "ready", __onTimeout: "continue" },
            });
            await insertAttempt(adapter, "continue-run", continueDesc, "waiting-event");
            expect(await I.resolveWaitForEventTimeoutBridge(adapter, "continue-run", continueDesc, 1, {
                ...baseSnapshot,
                onTimeout: "continue",
            })).toEqual({ handled: true, state: "failed" });

            const failDesc = makeDesc(tables, {
                nodeId: "wait-timeout-fail",
                meta: { __waitForEvent: true, __eventName: "ready" },
            });
            await insertAttempt(adapter, "timeout-fail-run", failDesc, "waiting-event");
            expect(await I.resolveWaitForEventTimeoutBridge(adapter, "timeout-fail-run", failDesc, 1, baseSnapshot)).toEqual({
                handled: true,
                state: "failed",
            });
        }
        finally {
            cleanup();
        }
    });

    test("resolves wait-for-event state from output, signals and terminal attempts", async () => {
        const { adapter, db, tables, cleanup } = makeHarness();
        try {
            const outputDesc = makeDesc(tables, {
                nodeId: "wait-output",
                meta: { __waitForEvent: true, __eventName: "ready" },
            });
            await insertAttempt(adapter, "output-run", outputDesc, "waiting-event");
            await db.insert(tables.outputA).values({
                runId: "output-run",
                nodeId: outputDesc.nodeId,
                iteration: 0,
                value: 11,
            });
            expect(await I.resolveWaitForEventTaskStateBridge(adapter, db, "output-run", outputDesc, makeEventBus())).toEqual({
                handled: true,
                state: "finished",
            });

            const invalidSignalDesc = makeDesc(tables, {
                nodeId: "wait-invalid-signal",
                meta: { __waitForEvent: true, __eventName: "ready" },
            });
            await insertAttempt(adapter, "invalid-signal-run", invalidSignalDesc, "waiting-event", {
                metaJson: JSON.stringify(I.buildWaitForEventAttemptMeta({
                    signalName: "ready",
                    correlationId: null,
                    onTimeout: "fail",
                    timeoutMs: null,
                    waitAsync: false,
                    startedAtMs: Date.now() - 10,
                })),
            });
            await bridgeWaitForEventResolve(adapter, "invalid-signal-run", invalidSignalDesc.nodeId, 0, {
                signalName: "ready",
                correlationId: null,
                payloadJson: "{",
                seq: 1,
                receivedAtMs: Date.now(),
            });
            expect(await I.resolveWaitForEventTaskStateBridge(adapter, db, "invalid-signal-run", invalidSignalDesc, makeEventBus())).toEqual({
                handled: true,
                state: "failed",
            });

            const invalidOutputDesc = makeDesc(tables, {
                nodeId: "wait-invalid-output",
                meta: { __waitForEvent: true, __eventName: "ready" },
            });
            await insertAttempt(adapter, "invalid-output-run", invalidOutputDesc, "waiting-event");
            db.$client.run(
                "INSERT INTO output_a (run_id, node_id, iteration, value) VALUES (?, ?, ?, ?)",
                ["invalid-output-run", invalidOutputDesc.nodeId, 0, "oops"],
            );
            expect(await I.resolveWaitForEventTaskStateBridge(adapter, db, "invalid-output-run", invalidOutputDesc, makeEventBus())).toEqual({
                handled: true,
                state: "waiting-event",
            });

            const newWaitDesc = makeDesc(tables, {
                nodeId: "wait-new",
                waitAsync: true,
                timeoutMs: 10,
                meta: { __waitForEvent: true, __eventName: "ready" },
            });
            expect(await I.resolveWaitForEventTaskStateBridge(adapter, db, "new-wait-run", newWaitDesc, makeEventBus())).toEqual({
                handled: true,
                state: "waiting-event",
            });

            const timeoutDesc = makeDesc(tables, {
                nodeId: "wait-zero",
                timeoutMs: 0,
                meta: { __waitForEvent: true, __eventName: "ready", __onTimeout: "skip" },
            });
            expect(await I.resolveWaitForEventTaskStateBridge(adapter, db, "timeout-run", timeoutDesc, makeEventBus())).toEqual({
                handled: true,
                state: "skipped",
            });

            for (const [state, expected, emitted] of [
                ["finished", "finished", undefined],
                ["skipped", "skipped", "skipped"],
                ["cancelled", "skipped", "skipped"],
                ["failed", "failed", "failed"],
            ]) {
                const desc = makeDesc(tables, {
                    nodeId: `wait-${state}`,
                    meta: { __waitForEvent: true, __eventName: "ready" },
                });
                await insertAttempt(adapter, `terminal-${state}`, desc, state);
                const states = [];
                expect(await I.resolveWaitForEventTaskStateBridge(adapter, db, `terminal-${state}`, desc, makeEventBus(), (next) => states.push(next))).toEqual({
                    handled: true,
                    state: expected,
                });
                if (emitted) {
                    expect(states).toEqual([emitted]);
                }
            }
            const unknown = makeDesc(tables, {
                nodeId: "wait-running",
                meta: { __waitForEvent: true, __eventName: "ready" },
            });
            await insertAttempt(adapter, "terminal-running", unknown, "in-progress");
            expect(await I.resolveWaitForEventTaskStateBridge(adapter, db, "terminal-running", unknown, makeEventBus())).toEqual({
                handled: false,
            });
        }
        finally {
            cleanup();
        }
    });

    test("reconciles human requests and approval denial branches", async () => {
        const { adapter, db, tables, cleanup } = makeHarness();
        try {
            const humanDesc = makeDesc(tables, {
                nodeId: "human",
                needsApproval: true,
                meta: { humanTask: true, prompt: "Answer" },
                timeoutMs: 100,
            });
            await I.ensurePendingHumanRequest(adapter, "human-run", humanDesc, 1_000);
            await I.ensurePendingHumanRequest(adapter, "human-run", humanDesc, 1_000);
            const requestId = buildHumanRequestId("human-run", "human", 0);
            expect((await Effect.runPromise(adapter.getHumanRequest(requestId)))?.prompt).toBe("Answer");
            const reopenRequestId = buildHumanRequestId("reopen-run", "human", 0);
            await Effect.runPromise(adapter.insertHumanRequest({
                requestId: reopenRequestId,
                runId: "reopen-run",
                nodeId: "human",
                iteration: 0,
                kind: "json",
                status: "answered",
                prompt: "Other",
                schemaJson: null,
                optionsJson: null,
                responseJson: "{}",
                requestedAtMs: 1,
                answeredAtMs: 10,
                answeredBy: "alice",
                timeoutAtMs: null,
            }));
            expect(await I.reconcileHumanRequestValidationFailure(adapter, "human-run", makeDesc(tables, { nodeId: "plain" }))).toBeUndefined();
            await insertAttempt(adapter, "reopen-run", humanDesc, "failed", {
                finishedAtMs: 20,
                errorJson: JSON.stringify({ code: "HUMAN_TASK_VALIDATION_FAILED" }),
            });
            expect(await I.reconcileHumanRequestValidationFailure(adapter, "reopen-run", humanDesc)).toMatchObject({
                status: "pending",
                responseJson: null,
                answeredAtMs: null,
                answeredBy: null,
            });
            await Effect.runPromise(adapter.insertHumanRequest({
                requestId: "human:late:human:0",
                runId: "late",
                nodeId: "human",
                iteration: 0,
                kind: "json",
                status: "answered",
                prompt: "Late",
                schemaJson: null,
                optionsJson: null,
                responseJson: "{}",
                requestedAtMs: 1,
                answeredAtMs: 30,
                answeredBy: "alice",
                timeoutAtMs: null,
            }));
            await insertAttempt(adapter, "late", humanDesc, "failed", {
                finishedAtMs: 20,
                errorJson: JSON.stringify({ code: "HUMAN_TASK_VALIDATION_FAILED" }),
            });
            expect(await I.reconcileHumanRequestValidationFailure(adapter, "late", humanDesc)).toMatchObject({
                status: "answered",
                answeredAtMs: 30,
            });
            await Effect.runPromise(adapter.insertHumanRequest({
                requestId: "human:no-reopen:human:0",
                runId: "no-reopen",
                nodeId: "human",
                iteration: 0,
                kind: "json",
                status: "answered",
                prompt: "No reopen",
                schemaJson: null,
                optionsJson: null,
                responseJson: "{}",
                requestedAtMs: 1,
                answeredAtMs: 10,
                answeredBy: "alice",
                timeoutAtMs: null,
            }));
            await insertAttempt(adapter, "no-reopen", humanDesc, "failed", {
                finishedAtMs: 20,
                errorJson: JSON.stringify({ code: "OTHER" }),
            });
            expect(await I.reconcileHumanRequestValidationFailure(adapter, "no-reopen", humanDesc)).toMatchObject({
                status: "answered",
            });

            expect(await I.resolveApprovalTaskStateBridge(adapter, db, "plain-run", makeDesc(tables, { nodeId: "plain-approval", needsApproval: false }), makeEventBus())).toEqual({
                handled: false,
            });
            const deniedDesc = makeDesc(tables, {
                nodeId: "select-denied",
                needsApproval: true,
                approvalMode: "select",
                approvalOnDeny: "continue",
            });
            await db.insert(tables.outputA).values({
                runId: "approval-run",
                nodeId: deniedDesc.nodeId,
                iteration: 0,
                value: 99,
            });
            await Effect.runPromise(adapter.insertOrUpdateApproval({
                runId: "approval-run",
                nodeId: deniedDesc.nodeId,
                iteration: 0,
                status: "denied",
                requestedAtMs: 1,
                decidedAtMs: 2,
                note: null,
                decidedBy: null,
                requestJson: "{}",
                decisionJson: null,
                autoApproved: false,
            }));
            expect(await I.resolveApprovalTaskStateBridge(adapter, db, "approval-run", deniedDesc, makeEventBus())).toEqual({
                handled: true,
                state: "finished",
            });
            const invalidDeniedDesc = makeDesc(tables, {
                nodeId: "select-denied-invalid",
                needsApproval: true,
                approvalMode: "select",
                approvalOnDeny: "continue",
            });
            db.$client.run(
                "INSERT INTO output_a (run_id, node_id, iteration, value) VALUES (?, ?, ?, ?)",
                ["approval-invalid-run", invalidDeniedDesc.nodeId, 0, "oops"],
            );
            await Effect.runPromise(adapter.insertOrUpdateApproval({
                runId: "approval-invalid-run",
                nodeId: invalidDeniedDesc.nodeId,
                iteration: 0,
                status: "denied",
                requestedAtMs: 1,
                decidedAtMs: 2,
                note: null,
                decidedBy: null,
                requestJson: "{}",
                decisionJson: null,
                autoApproved: false,
            }));
            const pendingStates = [];
            expect(await I.resolveApprovalTaskStateBridge(adapter, db, "approval-invalid-run", invalidDeniedDesc, makeEventBus(), (state) => pendingStates.push(state))).toEqual({
                handled: true,
                state: "pending",
            });
            expect(pendingStates).toEqual(["pending"]);

            const pendingHumanDesc = makeDesc(tables, {
                nodeId: "approved-human",
                needsApproval: true,
                meta: { humanTask: true, prompt: "Still pending" },
            });
            await Effect.runPromise(adapter.insertOrUpdateApproval({
                runId: "approved-human-run",
                nodeId: pendingHumanDesc.nodeId,
                iteration: 0,
                status: "approved",
                requestedAtMs: 1,
                decidedAtMs: 2,
                note: null,
                decidedBy: null,
                requestJson: "{}",
                decisionJson: null,
                autoApproved: false,
            }));
            await I.ensurePendingHumanRequest(adapter, "approved-human-run", pendingHumanDesc, 1);
            expect(await I.resolveApprovalTaskStateBridge(adapter, db, "approved-human-run", pendingHumanDesc, makeEventBus())).toEqual({
                handled: true,
                state: "waiting-approval",
            });

            const pendingDesc = makeDesc(tables, {
                nodeId: "weird-approval",
                needsApproval: true,
            });
            await Effect.runPromise(adapter.insertOrUpdateApproval({
                runId: "weird-run",
                nodeId: pendingDesc.nodeId,
                iteration: 0,
                status: "paused",
                requestedAtMs: 1,
                decidedAtMs: null,
                note: null,
                decidedBy: null,
                requestJson: "{}",
                decisionJson: null,
                autoApproved: false,
            }));
            await I.syncApprovalDurableDeferredFromDb(adapter, "weird-run", pendingDesc, {
                status: "approved",
                note: null,
                decidedBy: null,
                decisionJson: null,
                autoApproved: false,
            });
            expect(await I.resolveApprovalTaskStateBridge(adapter, db, "weird-run", pendingDesc, makeEventBus())).toEqual({
                handled: true,
                state: "waiting-approval",
            });

            const autoDesc = makeDesc(tables, {
                nodeId: "auto",
                needsApproval: true,
                approvalMode: "rank",
                approvalOptions: [{ key: "a" }, { key: "b" }],
                approvalAutoApprove: { after: 0, audit: true },
            });
            await insertRun(adapter, "auto-run");
            expect(await I.resolveApprovalTaskStateBridge(adapter, db, "auto-run", autoDesc, makeEventBus())).toEqual({
                handled: false,
            });

            const negativeAutoDesc = makeDesc(tables, {
                nodeId: "negative-auto",
                needsApproval: true,
                approvalAutoApprove: { after: -1, audit: true },
            });
            const negativeEventBus = makeEventBus();
            await insertRun(adapter, "negative-auto-run");
            expect(await I.resolveApprovalTaskStateBridge(adapter, db, "negative-auto-run", negativeAutoDesc, negativeEventBus)).toEqual({
                handled: true,
                state: "waiting-approval",
            });
            expect(await Effect.runPromise(adapter.getApproval("negative-auto-run", "negative-auto", 0))).toMatchObject({
                status: "requested",
                autoApproved: false,
            });
            expect(negativeEventBus.events.map((event) => event.type)).toEqual([
                "ApprovalRequested",
                "NodeWaitingApproval",
            ]);
        }
        finally {
            cleanup();
        }
    });

    test("cancels pending timer nodes with waiting attempts", async () => {
        const { adapter, tables, cleanup } = makeHarness();
        try {
            const eventBus = makeEventBus();
            const waitingDesc = makeDesc(tables, {
                nodeId: "cancel-me",
                meta: { __timer: true, __timerDuration: "10s" },
            });
            await insertAttempt(adapter, "cancel-run", waitingDesc, "waiting-timer", {
                metaJson: JSON.stringify(I.buildTimerAttemptMeta({
                    timerId: "cancel-me",
                    timerType: "duration",
                    duration: "10s",
                    createdAtMs: Date.now(),
                    firesAtMs: Date.now() + 10_000,
                })),
            });
            await Effect.runPromise(adapter.insertNode({
                runId: "cancel-run",
                nodeId: "cancel-me",
                iteration: 0,
                state: "waiting-timer",
                lastAttempt: 1,
                updatedAtMs: Date.now(),
                outputTable: "output_a",
                label: "Cancel me",
            }));
            await Effect.runPromise(adapter.insertNode({
                runId: "cancel-run",
                nodeId: "no-attempt",
                iteration: 0,
                state: "waiting-timer",
                lastAttempt: null,
                updatedAtMs: Date.now(),
                outputTable: "output_a",
                label: null,
            }));
            await I.cancelPendingTimersBridge(adapter, "cancel-run", eventBus, "stop");
            expect(eventBus.events.map((event) => event.type)).toEqual(["TimerCancelled", "NodeCancelled"]);
            expect((await Effect.runPromise(adapter.getNode("cancel-run", "cancel-me", 0)))?.state).toBe("cancelled");
        }
        finally {
            cleanup();
        }
    });
});
