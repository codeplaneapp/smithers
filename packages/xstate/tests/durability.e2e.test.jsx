/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { assign, createMachine } from "xstate";
import { SmithersDb, Task, WaitForEvent, Workflow, runWorkflow, signalRun } from "smithers-orchestrator";
import { jumpToFrame, listSnapshots, loadSnapshot, parseSnapshot, replayFromCheckpoint } from "@smithers-orchestrator/time-travel";
import { Effect } from "effect";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { taskOutput, eventReceived, timedOut, useSmithersMachine, __machineCacheInternals } from "../src/index.js";

const E2E_TIMEOUT_MS = 60_000;

/** Simulate a process crash between engine invocations: the in-process fold
 * cache dies with the process, so the next render must refold purely from
 * durable rows. */
function crash() {
    __machineCacheInternals.foldCache.clear();
}

function buildSmithers() {
    return createTestSmithers({
        stageOne: z.object({ value: z.number() }),
        stageTwo: z.object({ value: z.number() }),
        pathA: z.object({ picked: z.string() }),
        pathB: z.object({ picked: z.string() }),
        waitOut: z.object({ go: z.boolean() }),
        pickOut: z.object({ choice: z.string() }),
    });
}

describe("xstate durability through the real engine", () => {
    test("machine-driven staging survives crash/resume and a real signal drives the transition", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildSmithers();
        const adapter = new SmithersDb(db);
        const machine = createMachine({
            context: { goSeen: 0 },
            initial: "working",
            states: {
                working: { on: { TASK1_DONE: "waiting" } },
                waiting: { on: { GO: { target: "closing", actions: assign({ goSeen: ({ context }) => context.goSeen + 1 }) } } },
                closing: {},
            },
        });
        /** @type {Array<string>} */
        const probe = [];
        try {
            const workflow = smithers(() => {
                function Staged() {
                    const state = useSmithersMachine(machine, {
                        id: "stager",
                        events: [
                            taskOutput("stageOne", { nodeId: "task1" }, () => ({ type: "TASK1_DONE" })),
                            eventReceived("GO", z.object({ go: z.boolean() }), {}, () => ({ type: "GO" })),
                        ],
                    });
                    probe.push(JSON.stringify(state.value));
                    return (
                        <Workflow name="xstate-staged">
                            <Task id="task1" output={outputs.stageOne}>
                                {() => ({ value: 1 })}
                            </Task>
                            {state.matches("waiting") && (
                                <WaitForEvent id="go-listener" event="GO" output={outputs.waitOut} />
                            )}
                            {state.matches("closing") && (
                                <Task id="task2" output={outputs.stageTwo}>
                                    {() => ({ value: 2 })}
                                </Task>
                            )}
                        </Workflow>
                    );
                }
                return <Staged />;
            });

            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-event");
            expect(probe.at(-1)).toBe('"waiting"');
            expect(await db.select().from(tables.stageOne)).toHaveLength(1);

            // Crash/resume identity with NO new rows: the machine must land in
            // exactly the state the durable rows imply — still "waiting".
            crash();
            probe.length = 0;
            const parkedResume = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: first.runId, resume: true }));
            expect(parkedResume.status).toBe("waiting-event");
            expect(probe[0]).toBe('"waiting"');
            expect(probe.at(-1)).toBe('"waiting"');
            expect(await db.select().from(tables.stageOne)).toHaveLength(1);

            // A real signal delivery (the `smithers signal` path) drives the
            // machine transition end-to-end after another crash.
            await Effect.runPromise(signalRun(adapter, first.runId, "GO", { go: true }, { receivedBy: "tester" }));
            crash();
            probe.length = 0;
            const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: first.runId, resume: true }));
            expect(finished.status).toBe("finished");
            expect(probe[0]).toBe('"closing"');
            expect(await db.select().from(tables.stageTwo)).toHaveLength(1);
            // task1 was never re-executed across two crashes and resumes.
            expect(await db.select().from(tables.stageOne)).toHaveLength(1);
        }
        finally {
            cleanup();
        }
    }, E2E_TIMEOUT_MS);

    test("rewind to an earlier frame yields the earlier machine state from restored rows", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildSmithers();
        const adapter = new SmithersDb(db);
        const machine = createMachine({
            initial: "s0",
            states: {
                s0: { on: { A_DONE: "s1" } },
                s1: { on: { B_DONE: "s2" } },
                s2: {},
            },
        });
        /** @type {Array<string>} */
        const probe = [];
        try {
            const workflow = smithers(() => {
                function Staged() {
                    const state = useSmithersMachine(machine, {
                        id: "rewinder",
                        events: [
                            taskOutput("stageOne", { nodeId: "taskA" }, () => ({ type: "A_DONE" })),
                            taskOutput("stageTwo", { nodeId: "taskB" }, () => ({ type: "B_DONE" })),
                        ],
                    });
                    probe.push(JSON.stringify(state.value));
                    return (
                        <Workflow name="xstate-rewind">
                            <Task id="taskA" output={outputs.stageOne}>
                                {() => ({ value: 10 })}
                            </Task>
                            {(state.matches("s1") || state.matches("s2")) && (
                                <Task id="taskB" output={outputs.stageTwo}>
                                    {() => ({ value: 20 })}
                                </Task>
                            )}
                        </Workflow>
                    );
                }
                return <Staged />;
            });

            const runId = "xstate-rewind-run";
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(first.status).toBe("finished");
            expect(probe.at(-1)).toBe('"s2"');

            // Target: the latest frame whose snapshot has taskA's output but
            // not yet taskB's — the durable embodiment of machine state "s1".
            const snapshots = await listSnapshots(adapter, runId);
            let targetFrameNo = -1;
            for (const meta of snapshots) {
                const parsed = parseSnapshot(await loadSnapshot(adapter, runId, meta.frameNo));
                const hasA = (parsed.outputs.stageOne ?? []).length > 0;
                const hasB = (parsed.outputs.stageTwo ?? []).length > 0;
                if (hasA && !hasB) targetFrameNo = Math.max(targetFrameNo, meta.frameNo);
            }
            expect(targetFrameNo).toBeGreaterThanOrEqual(0);

            const jump = await jumpToFrame({
                adapter,
                runId,
                frameNo: targetFrameNo,
                confirm: true,
                getCurrentPointerImpl: async () => "test-pointer",
                revertToPointerImpl: async () => ({ success: true }),
            });
            expect(jump.ok).toBe(true);
            expect(await db.select().from(tables.stageTwo).where(eq(tables.stageTwo.runId, runId))).toHaveLength(0);

            // Resume after rewind: the first fold from restored rows must put
            // the machine back in "s1", then the run re-executes taskB and
            // reconverges to "s2".
            crash();
            probe.length = 0;
            const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
            expect(resumed.status).toBe("finished");
            expect(probe[0]).toBe('"s1"');
            expect(probe.at(-1)).toBe('"s2"');
            expect(await db.select().from(tables.stageTwo).where(eq(tables.stageTwo.runId, runId))).toHaveLength(1);
        }
        finally {
            cleanup();
        }
    }, E2E_TIMEOUT_MS);

    test("a fork diverges cleanly: parent and child fold their own signal histories", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildSmithers();
        const adapter = new SmithersDb(db);
        const machine = createMachine({
            context: { choice: null },
            initial: "deciding",
            states: {
                deciding: {
                    on: {
                        PICK: [
                            { guard: ({ event }) => event.choice === "a", target: "pathA", actions: assign({ choice: ({ event }) => event.choice }) },
                            { target: "pathB", actions: assign({ choice: ({ event }) => event.choice }) },
                        ],
                    },
                },
                pathA: {},
                pathB: {},
            },
        });
        try {
            const workflow = smithers(() => {
                function Decider() {
                    const state = useSmithersMachine(machine, {
                        id: "decider",
                        events: [
                            eventReceived("PICK", z.object({ choice: z.string() }), {}, (p) => ({ type: "PICK", choice: p.choice })),
                        ],
                    });
                    return (
                        <Workflow name="xstate-fork">
                            {state.matches("deciding") && (
                                <WaitForEvent id="pick-listener" event="PICK" output={outputs.pickOut} />
                            )}
                            {state.matches("pathA") && (
                                <Task id="taskA" output={outputs.pathA}>
                                    {() => ({ picked: "a" })}
                                </Task>
                            )}
                            {state.matches("pathB") && (
                                <Task id="taskB" output={outputs.pathB}>
                                    {() => ({ picked: "b" })}
                                </Task>
                            )}
                        </Workflow>
                    );
                }
                return <Decider />;
            });

            const parentRunId = "xstate-fork-parent";
            const parked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: parentRunId }));
            expect(parked.status).toBe("waiting-event");

            const parentSnapshots = await listSnapshots(adapter, parentRunId);
            const forkFrameNo = parentSnapshots[parentSnapshots.length - 1].frameNo;
            const replay = await replayFromCheckpoint(adapter, { parentRunId, frameNo: forkFrameNo });
            const childRunId = replay.runId;
            expect(childRunId).not.toBe(parentRunId);

            // Divergent external decisions: parent picks "a", child picks "b".
            await Effect.runPromise(signalRun(adapter, parentRunId, "PICK", { choice: "a" }, { receivedBy: "tester" }));
            await Effect.runPromise(signalRun(adapter, childRunId, "PICK", { choice: "b" }, { receivedBy: "tester" }));

            crash();
            const parentDone = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: parentRunId, resume: true }));
            expect(parentDone.status).toBe("finished");
            crash();
            const childDone = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: childRunId, resume: true }));
            expect(childDone.status).toBe("finished");

            const parentA = await db.select().from(tables.pathA).where(eq(tables.pathA.runId, parentRunId));
            const parentB = await db.select().from(tables.pathB).where(eq(tables.pathB.runId, parentRunId));
            const childA = await db.select().from(tables.pathA).where(eq(tables.pathA.runId, childRunId));
            const childB = await db.select().from(tables.pathB).where(eq(tables.pathB.runId, childRunId));
            expect(parentA).toHaveLength(1);
            expect(parentB).toHaveLength(0);
            expect(childA).toHaveLength(0);
            expect(childB).toHaveLength(1);
        }
        finally {
            cleanup();
        }
    }, E2E_TIMEOUT_MS);

    test("a signal delivered before its listener ever mounts still reaches the fold (no waiter parked)", async () => {
        // Rev 3's central claim: eventReceived folds `_smithers_signals` directly,
        // so delivery never depends on a <WaitForEvent> being parked at the
        // moment it happens — the exact gap the old one-shot-waiter design lost
        // (a signal in the gap between one generation's resolution and the
        // next generation's attempt insert). Here BOTH "X" and "Y" are
        // delivered before the run ever renders a listener for "Y" (the
        // machine hasn't even left waitingX yet), then a single resume must
        // still carry the machine through both transitions to "done".
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            xOut: z.object({ ok: z.boolean() }),
            yOut: z.object({ ok: z.boolean() }),
        });
        const adapter = new SmithersDb(db);
        const machine = createMachine({
            initial: "waitingX",
            states: {
                waitingX: { on: { X: "waitingY" } },
                waitingY: { on: { Y: "done" } },
                done: { type: "final" },
            },
        });
        try {
            const workflow = smithers(() => {
                function Chained() {
                    const state = useSmithersMachine(machine, {
                        id: "chain",
                        events: [
                            eventReceived("X", z.object({ ok: z.boolean() }), {}, () => ({ type: "X" })),
                            eventReceived("Y", z.object({ ok: z.boolean() }), {}, () => ({ type: "Y" })),
                        ],
                    });
                    return (
                        <Workflow name="xstate-signal-gap">
                            {state.matches("waitingX") && (
                                <WaitForEvent id="x-listener" event="X" output={outputs.xOut} />
                            )}
                            {state.matches("waitingY") && (
                                <WaitForEvent id="y-listener" event="Y" output={outputs.yOut} />
                            )}
                        </Workflow>
                    );
                }
                return <Chained />;
            });

            const runId = "xstate-signal-gap-run";
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(first.status).toBe("waiting-event");

            // Both signals land while only the "X" listener has ever mounted —
            // "Y" is delivered without ANY <WaitForEvent id="y-listener"> attempt
            // ever having existed yet.
            await Effect.runPromise(signalRun(adapter, runId, "X", { ok: true }, { receivedBy: "tester" }));
            await Effect.runPromise(signalRun(adapter, runId, "Y", { ok: true }, { receivedBy: "tester" }));

            crash();
            const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
            expect(finished.status).toBe("finished");
        }
        finally {
            cleanup();
        }
    }, E2E_TIMEOUT_MS);

    test("rewinding past a delivered signal makes the machine forget it (signal horizon filtering)", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            stageOne: z.object({ value: z.number() }),
            pingOut: z.object({ ok: z.boolean() }),
        });
        const adapter = new SmithersDb(db);
        const machine = createMachine({
            initial: "s0",
            states: {
                s0: { on: { A_DONE: "s1" } },
                s1: { on: { PING: "s2" } },
                s2: {},
            },
        });
        /** @type {Array<string>} */
        const probe = [];
        try {
            const workflow = smithers(() => {
                function Pinger() {
                    const state = useSmithersMachine(machine, {
                        id: "pinger",
                        events: [
                            taskOutput("stageOne", { nodeId: "taskA" }, () => ({ type: "A_DONE" })),
                            eventReceived("PING", z.object({ ok: z.boolean() }), {}, () => ({ type: "PING" })),
                        ],
                    });
                    probe.push(JSON.stringify(state.value));
                    return (
                        <Workflow name="xstate-signal-rewind">
                            <Task id="taskA" output={outputs.stageOne}>
                                {() => ({ value: 10 })}
                            </Task>
                            {state.matches("s1") && (
                                <WaitForEvent id="ping-listener" event="PING" output={outputs.pingOut} />
                            )}
                        </Workflow>
                    );
                }
                return <Pinger />;
            });

            const runId = "xstate-signal-rewind-run";
            const parked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(parked.status).toBe("waiting-event");
            expect(probe.at(-1)).toBe('"s1"');

            // The latest snapshot right now — before PING is ever delivered —
            // is the durable embodiment of "s1, PING not yet seen".
            const beforePing = await listSnapshots(adapter, runId);
            const targetFrameNo = beforePing[beforePing.length - 1].frameNo;

            await Effect.runPromise(signalRun(adapter, runId, "PING", { ok: true }, { receivedBy: "tester" }));
            crash();
            const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
            expect(finished.status).toBe("finished");
            expect(probe.at(-1)).toBe('"s2"');

            const jump = await jumpToFrame({
                adapter,
                runId,
                frameNo: targetFrameNo,
                confirm: true,
                getCurrentPointerImpl: async () => "test-pointer",
                revertToPointerImpl: async () => ({ success: true }),
            });
            expect(jump.ok).toBe(true);

            // The rewound row set must no longer contain the PING signal.
            crash();
            probe.length = 0;
            const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, resume: true }));
            // Without a fresh PING delivery the machine is genuinely back to
            // "s1" and the run parks again — it does not silently re-finish
            // from a signal row the rewind should have discarded.
            expect(resumed.status).toBe("waiting-event");
            expect(probe[0]).toBe('"s1"');
            expect(probe.at(-1)).toBe('"s1"');
        }
        finally {
            cleanup();
        }
    }, E2E_TIMEOUT_MS);

    test("the run finishes on a quiescent graph even though the machine never reaches a final state (documented, dangerous contract)", async () => {
        // The most dangerous of the four final-state/liveness differences
        // from a live actor: a machine state awaiting an external event that
        // renders no listener makes the graph quiescent, and the RUN ends —
        // silently, from the machine's point of view it is still mid-flight.
        // This is a documented contract, not a bug, so it must be pinned.
        const { smithers, outputs, cleanup } = createTestSmithers({
            yOut: z.object({ ok: z.boolean() }),
        });
        const machine = createMachine({
            initial: "waitingY",
            states: {
                waitingY: { on: { Y: "done" } },
                done: { type: "final" },
            },
        });
        /** @type {Array<string>} */
        const probe = [];
        try {
            const workflow = smithers(() => {
                function Orphan() {
                    const state = useSmithersMachine(machine, {
                        id: "orphan",
                        events: [eventReceived("Y", z.object({ ok: z.boolean() }), {}, () => ({ type: "Y" }))],
                    });
                    probe.push(state.status);
                    // Deliberately renders nothing for "waitingY" — no
                    // <WaitForEvent>, no <Task> — the authoring bug this
                    // contract test documents.
                    return <Workflow name="xstate-quiescent" />;
                }
                return <Orphan />;
            });

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            expect(probe.at(-1)).toBe("active");
        }
        finally {
            cleanup();
        }
    }, E2E_TIMEOUT_MS);

    test("a failure-flavored final state does not fail the run, does not cancel other rendered tasks, and snapshot.output is not run output", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            stageOne: z.object({ value: z.number() }),
            stageTwo: z.object({ value: z.number() }),
        });
        const machine = createMachine({
            initial: "working",
            output: () => ({ error: "boom" }),
            states: {
                working: { on: { TASK1_DONE: "failed" } },
                failed: { type: "final", tags: ["failure"] },
            },
        });
        /** @type {Array<import("xstate").AnyMachineSnapshot>} */
        const probe = [];
        try {
            const workflow = smithers(() => {
                function Outcome() {
                    const state = useSmithersMachine(machine, {
                        id: "outcome",
                        events: [taskOutput("stageOne", { nodeId: "task1" }, () => ({ type: "TASK1_DONE" }))],
                    });
                    probe.push(state);
                    return (
                        <Workflow name="xstate-final-semantics">
                            <Task id="task1" output={outputs.stageOne}>
                                {() => ({ value: 1 })}
                            </Task>
                            {/* Unconditional — proves the engine does not
                                cancel/skip rendering other tasks just because
                                the derived machine reached a final state. */}
                            <Task id="always" output={outputs.stageTwo}>
                                {() => ({ value: 2 })}
                            </Task>
                        </Workflow>
                    );
                }
                return <Outcome />;
            });

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            expect(result.output).toBeUndefined();
            const finalState = probe.at(-1);
            expect(finalState.status).toBe("done");
            expect(finalState.hasTag("failure")).toBe(true);
            expect(finalState.output).toEqual({ error: "boom" });
            expect(await db.select().from(tables.stageOne)).toHaveLength(1);
            expect(await db.select().from(tables.stageTwo)).toHaveLength(1);
        }
        finally {
            cleanup();
        }
    }, E2E_TIMEOUT_MS);

    test("timedOut() pointed at a non-tagged WaitForEvent(onTimeout='continue') hard-errors instead of silently never firing", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers({
            waitOut: z.object({ kind: z.string() }).passthrough(),
        });
        const adapter = new SmithersDb(db);
        const machine = createMachine({
            initial: "waiting",
            states: {
                waiting: { on: { TIMED_OUT: "done" } },
                done: {},
            },
        });
        try {
            const workflow = smithers(() => {
                function Untagged() {
                    const state = useSmithersMachine(machine, {
                        id: "untagged-timeout",
                        events: [
                            timedOut("waitOut", { nodeId: "waiter" }, () => ({ type: "TIMED_OUT" })),
                        ],
                    });
                    return (
                        <Workflow name="xstate-untagged-timeout">
                            {state.matches("waiting") && (
                                <WaitForEvent
                                    id="waiter"
                                    event="NEVER"
                                    timeoutMs={1}
                                    onTimeout="continue"
                                    output={outputs.waitOut}
                                />
                            )}
                        </Workflow>
                    );
                }
                return <Untagged />;
            });

            // The wait only registers the timer on the first render; the
            // timeout itself is only observed on a later poll once timeoutMs
            // has actually elapsed (bridge-managed, not synchronous).
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-event");
            await new Promise((resolve) => setTimeout(resolve, 50));

            // The engine isolates task failures rather than rejecting the run
            // promise: the node fails with a well-named, typed error instead
            // of the timedOut() source silently never firing forever.
            const finished = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: first.runId, resume: true }));
            expect(finished.status).toBe("finished");
            expect(finished.failedChildKeys).toContain("waiter::0");
            const attempts = await Effect.runPromise(adapter.listAttemptsForRun(first.runId));
            const waiterAttempt = attempts.find((attempt) => attempt.nodeId === "waiter");
            expect(String(waiterAttempt?.errorJson ?? "")).toContain("TASK_OUTPUT_SCHEMA_INVALID");
            expect(String(waiterAttempt?.errorJson ?? "")).toContain("tagged");
        }
        finally {
            cleanup();
        }
    }, E2E_TIMEOUT_MS);
});
