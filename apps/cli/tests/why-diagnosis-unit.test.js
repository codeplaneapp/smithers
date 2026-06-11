import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import {
    diagnoseRunEffect,
    diagnosisCtaCommands,
    renderWhyDiagnosisHuman,
} from "../src/why-diagnosis.js";

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

function runRow(overrides = {}) {
    return {
        runId: "diag-run",
        workflowName: "diagnosis",
        workflowPath: "workflow with spaces.tsx",
        status: "running",
        createdAtMs: NOW - 120_000,
        startedAtMs: NOW - 110_000,
        finishedAtMs: null,
        heartbeatAtMs: NOW,
        ...overrides,
    };
}

function nodeRow(overrides = {}) {
    return {
        runId: "diag-run",
        nodeId: "node",
        iteration: 0,
        state: "pending",
        lastAttempt: null,
        updatedAtMs: NOW - 10_000,
        outputTable: "node_output",
        label: null,
        ...overrides,
    };
}

function attemptRow(overrides = {}) {
    return {
        runId: "diag-run",
        nodeId: "node",
        iteration: 0,
        attempt: 1,
        state: "failed",
        startedAtMs: NOW - 20_000,
        finishedAtMs: NOW - 19_000,
        errorJson: null,
        metaJson: null,
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: "/tmp/diag",
        ...overrides,
    };
}

function approvalRow(overrides = {}) {
    return {
        runId: "diag-run",
        nodeId: "approval-gate",
        iteration: 0,
        status: "requested",
        requestedAtMs: NOW - 90_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
        ...overrides,
    };
}

function eventRow(seq, payloadJson, overrides = {}) {
    return {
        runId: "diag-run",
        seq,
        type: "TestEvent",
        timestampMs: NOW - 4_000 + seq,
        payloadJson,
        ...overrides,
    };
}

function workflowFrame(children) {
    return {
        runId: "diag-run",
        frameNo: 1,
        createdAtMs: NOW - 30_000,
        xmlJson: JSON.stringify({
            kind: "element",
            tag: "smithers:workflow",
            props: { name: "diagnosis" },
            children,
        }),
        xmlHash: "hash",
        mountedTaskIdsJson: "[]",
        taskIndexJson: "[]",
        note: null,
    };
}

function makeAdapter(state = {}) {
    const queries = [];
    const data = {
        run: runRow(),
        nodes: [],
        approvals: [],
        attempts: [],
        events: [],
        lastSeq: undefined,
        lastFrame: undefined,
        ...state,
    };
    const adapter = {
        queries,
        getRunEffect: () => Effect.succeed(data.run),
        listNodesEffect: () => Effect.succeed(data.nodes),
        listPendingApprovalsEffect: () => Effect.succeed(data.approvals),
        listAllDecidedApprovalsEffect: () => Effect.succeed([]),
        listAttemptsForRunEffect: () => Effect.succeed(data.attempts),
        getLastEventSeqEffect: () => Effect.succeed(data.lastSeq),
        getLastFrameEffect: () => Effect.succeed(data.lastFrame),
        listEventHistoryEffect: (_runId, query) => {
            queries.push(query);
            return Effect.succeed(data.events);
        },
    };
    return adapter;
}

function diagnose(adapter, runId = "diag-run", nowMs = NOW) {
    return Effect.runPromise(diagnoseRunEffect(adapter, runId, nowMs));
}

describe("why diagnosis unit coverage", () => {
    test("diagnoses mixed blockers from frames, attempts, approvals, and events", async () => {
        const adapter = makeAdapter({
            lastSeq: 75,
            lastFrame: workflowFrame([
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "approval-gate", retries: "2" },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:wait-for-event",
                    props: {
                        id: "wait-signal",
                        __smithersOnTimeout: "cancel",
                    },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:timer",
                    props: { id: "cooldown", duration: "5m" },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: {
                        id: "stale task",
                        heartbeatTimeout: "10000",
                        retries: "1",
                    },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: {
                        id: "retry-pending",
                        retries: "2",
                        retryPolicy: JSON.stringify({
                            initialDelayMs: "5000",
                            backoff: "fixed",
                        }),
                    },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:subflow",
                    props: { id: "child-flow", label: "Child flow" },
                    children: [{ kind: "text", value: "ignored" }],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "dep-a", continueOnFail: "false" },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "dep-b", dependsOn: "dep-a, missing" },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "ignored-fail", continueOnFail: "1" },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "dep-skip", dependsOn: "[\"ignored-fail\"]" },
                    children: [],
                },
            ]),
            nodes: [
                nodeRow({
                    nodeId: "approval-gate",
                    state: "waiting-approval",
                    lastAttempt: 2,
                    updatedAtMs: NOW - 92_000,
                }),
                nodeRow({
                    nodeId: "wait-signal@@1",
                    state: "waiting-event",
                    updatedAtMs: NOW - 80_000,
                }),
                nodeRow({
                    nodeId: "wait-signal@@2",
                    state: "finished",
                    updatedAtMs: NOW - 79_000,
                }),
                nodeRow({
                    nodeId: "cooldown",
                    state: "waiting-timer",
                    updatedAtMs: NOW - 70_000,
                }),
                nodeRow({
                    nodeId: "stale task",
                    state: "in-progress",
                    lastAttempt: 1,
                    updatedAtMs: NOW - 65_000,
                }),
                nodeRow({
                    nodeId: "retry-pending",
                    state: "pending",
                    lastAttempt: 1,
                    updatedAtMs: NOW - 60_000,
                }),
                nodeRow({
                    nodeId: "dep-a",
                    state: "failed",
                    lastAttempt: 1,
                    updatedAtMs: NOW - 50_000,
                }),
                nodeRow({
                    nodeId: "dep-b",
                    state: "pending",
                    updatedAtMs: NOW - 49_000,
                }),
                nodeRow({
                    nodeId: "ignored-fail",
                    state: "failed",
                    updatedAtMs: NOW - 45_000,
                }),
                nodeRow({
                    nodeId: "dep-skip",
                    state: "pending",
                    updatedAtMs: NOW - 44_000,
                }),
            ],
            approvals: [
                approvalRow(),
                approvalRow({
                    nodeId: "old-gate",
                    status: "approved",
                    requestedAtMs: NOW - 100_000,
                    decidedAtMs: NOW - 99_000,
                }),
            ],
            attempts: [
                attemptRow({
                    nodeId: "approval-gate",
                    attempt: 1,
                    errorJson: JSON.stringify({ message: "first review failed" }),
                    metaJson: JSON.stringify({
                        retries: 2,
                        retryPolicy: { initialDelayMs: 1_000, backoff: "fixed" },
                    }),
                }),
                attemptRow({
                    nodeId: "approval-gate",
                    attempt: 2,
                    state: "in-progress",
                    startedAtMs: NOW - 18_000,
                    finishedAtMs: null,
                    errorJson: null,
                    metaJson: JSON.stringify({ retries: 2 }),
                }),
                attemptRow({
                    nodeId: "wait-signal@@1",
                    attempt: 1,
                    errorJson: null,
                    metaJson: JSON.stringify({
                        retries: 2,
                        signal: "deploy ready",
                        correlationId: "ticket 42",
                    }),
                    finishedAtMs: NOW - 82_000,
                }),
                attemptRow({
                    nodeId: "stale task",
                    attempt: 1,
                    state: "in-progress",
                    heartbeatAtMs: null,
                    startedAtMs: NOW - 30_000,
                    finishedAtMs: null,
                    errorJson: null,
                }),
                attemptRow({
                    nodeId: "retry-pending",
                    attempt: 1,
                    errorJson: "raw failure",
                    finishedAtMs: NOW - 2_000,
                }),
                attemptRow({
                    nodeId: "dep-a",
                    attempt: 1,
                    errorJson: JSON.stringify("dependency exploded"),
                    metaJson: JSON.stringify({ retries: 0 }),
                    finishedAtMs: NOW - 51_000,
                }),
                attemptRow({
                    nodeId: "fresh-task",
                    state: "finished",
                    errorJson: null,
                    metaJson: "{bad json",
                }),
            ],
            events: [
                eventRow(26, "not json"),
                eventRow(27, JSON.stringify({ nodeId: "other", signalName: "wrong" })),
                eventRow(28, JSON.stringify({
                    nodeId: "wait-signal@@1",
                    iteration: 1,
                    event: "ignored.iteration",
                })),
                eventRow(29, JSON.stringify({
                    nodeId: "wait-signal@@1",
                    iteration: 0,
                    signalName: "deploy ready",
                    correlationId: "ticket 42",
                })),
                eventRow(30, JSON.stringify({
                    timerId: "other-timer",
                    firesAtMs: NOW + 1_000,
                })),
                eventRow(31, JSON.stringify({
                    timerId: "cooldown",
                    firesAtMs: String(NOW + 3_661_000),
                })),
            ],
        });

        const diagnosis = await diagnose(adapter);

        expect(adapter.queries).toEqual([{ afterSeq: 25, limit: 50 }]);
        expect(diagnosis.summary).toBe("Run diag-run is running");
        expect(diagnosis.currentNodeId).toBe("stale task");
        expect(diagnosis.blockers.map((blocker) => blocker.kind)).toEqual([
            "waiting-approval",
            "waiting-event",
            "waiting-timer",
            "retries-exhausted",
            "dependency-failed",
            "stale-task-heartbeat",
            "retry-backoff",
        ]);

        const approval = diagnosis.blockers.find((blocker) => blocker.kind === "waiting-approval");
        expect(approval?.unblocker).toBe("smithers approve diag-run --node approval-gate --iteration 0");
        expect(approval?.context).toContain("Deny instead: smithers deny diag-run --node approval-gate --iteration 0");
        expect(approval?.context).toContain("Previous attempt failed (attempt 1 of 3)");

        const signal = diagnosis.blockers.find((blocker) => blocker.kind === "waiting-event");
        expect(signal?.reason).toBe("waiting for signal 'deploy ready'");
        expect(signal?.unblocker).toBe("smithers signal diag-run 'deploy ready' --data '{}' --correlation 'ticket 42'");
        expect(signal?.context).toContain("On timeout: cancel");
        expect(signal?.context).toContain("Previous attempt failed (attempt 1 of 3).");
        expect(signal?.attempt).toBe(1);
        expect(signal?.maxAttempts).toBe(3);

        const timer = diagnosis.blockers.find((blocker) => blocker.kind === "waiting-timer");
        expect(timer?.remainingMs).toBe(3_661_000);
        expect(timer?.context).toContain("Time remaining: 1h 1m");

        const staleTask = diagnosis.blockers.find((blocker) => blocker.kind === "stale-task-heartbeat");
        expect(staleTask?.maxAttempts).toBe(2);
        expect(staleTask?.unblocker).toBe("smithers retry-task 'workflow with spaces.tsx' --run-id diag-run --node-id 'stale task' --iteration 0 --force true");

        const retry = diagnosis.blockers.find((blocker) => blocker.kind === "retry-backoff");
        expect(retry?.reason).toContain("retrying automatically in 3s");
        expect(retry?.context).toContain("raw failure");

        const exhausted = diagnosis.blockers.find((blocker) => blocker.kind === "retries-exhausted");
        expect(exhausted?.reason).toContain("dependency exploded");
        expect(exhausted?.context).toBe("Attempt 1 of 1");

        const dependency = diagnosis.blockers.find((blocker) => blocker.kind === "dependency-failed");
        expect(dependency?.dependencyNodeId).toBe("dep-a");
        expect(diagnosis.blockers.some((blocker) => blocker.nodeId === "dep-skip")).toBe(false);

        const human = renderWhyDiagnosisHuman(diagnosis);
        expect(human).toContain("Blocked node:  cooldown");
        expect(human).toContain("Fires at:");
        expect(human).toContain("Time remaining:");
        expect(human).toContain("Correlation: ticket 42");

        const ctas = diagnosisCtaCommands(diagnosis);
        expect(ctas[0]).toEqual({
            command: "approve diag-run --node approval-gate --iteration 0",
            description: "Approve pending gate",
        });
        expect(ctas.some((entry) => entry.command === "inspect diag-run")).toBe(true);
        expect(ctas.some((entry) => entry.command === "logs diag-run")).toBe(true);
    });

    test("covers parser fallbacks and sparse diagnosis rows", async () => {
        const adapter = makeAdapter({
            run: runRow({
                runId: "edge-run",
                workflowPath: null,
                status: "failed",
                createdAtMs: null,
                startedAtMs: null,
                finishedAtMs: null,
                heartbeatAtMs: null,
            }),
            lastFrame: workflowFrame([
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "single-dep", dependsOn: "solo-dep" },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "broken-deps", dependsOn: "[not-json]" },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "array-deps", dependsOn: ["not", "a", "string"] },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: { id: "empty-deps", dependsOn: " " },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:task",
                    props: {
                        id: "retry-no-delay",
                        retryPolicy: "{bad json",
                    },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:timer",
                    props: { id: "snap-timer", until: "tomorrow" },
                    children: [],
                },
                {
                    kind: "element",
                    tag: "smithers:timer",
                    props: { id: "empty-timer" },
                    children: [],
                },
            ]),
            nodes: [
                nodeRow({
                    runId: "edge-run",
                    nodeId: "edge-approval",
                    state: "waiting-approval",
                    updatedAtMs: null,
                }),
                nodeRow({
                    runId: "edge-run",
                    nodeId: "snap-timer",
                    state: "waiting-timer",
                    updatedAtMs: NOW - 7_000,
                }),
                nodeRow({
                    runId: "edge-run",
                    nodeId: "empty-timer",
                    state: "waiting-timer",
                    updatedAtMs: NOW - 6_000,
                }),
                nodeRow({
                    runId: "edge-run",
                    nodeId: "meta-timeout",
                    state: "in-progress",
                    lastAttempt: 1,
                    updatedAtMs: NOW - 5_000,
                }),
                nodeRow({
                    runId: "edge-run",
                    nodeId: "no-meta-timeout",
                    state: "in-progress",
                    lastAttempt: 1,
                    updatedAtMs: NOW - 4_000,
                }),
                nodeRow({
                    runId: "edge-run",
                    nodeId: "retry-no-delay",
                    state: "pending",
                    lastAttempt: 1,
                    updatedAtMs: NOW - 3_000,
                }),
                nodeRow({
                    runId: "edge-run",
                    nodeId: "no-finished",
                    state: "failed",
                    lastAttempt: 1,
                    updatedAtMs: NOW - 2_000,
                }),
                nodeRow({
                    runId: "edge-run",
                    nodeId: "number-error",
                    state: "failed",
                    lastAttempt: 1,
                    updatedAtMs: NOW - 1_000,
                }),
            ],
            approvals: [
                approvalRow({
                    runId: "edge-run",
                    nodeId: "edge-approval",
                    requestedAtMs: null,
                }),
            ],
            attempts: [
                attemptRow({
                    runId: "edge-run",
                    nodeId: "snap-timer",
                    state: "waiting-timer",
                    errorJson: null,
                    metaJson: JSON.stringify({
                        timer: {
                            timerId: "snap-timer",
                            firesAtMs: NOW + 90_061_000,
                        },
                    }),
                }),
                attemptRow({
                    runId: "edge-run",
                    nodeId: "meta-timeout",
                    state: "in-progress",
                    startedAtMs: NOW - 8_000,
                    heartbeatAtMs: NOW - 7_000,
                    finishedAtMs: null,
                    errorJson: null,
                    metaJson: JSON.stringify({ heartbeatTimeoutMs: "1000" }),
                }),
                attemptRow({
                    runId: "edge-run",
                    nodeId: "no-meta-timeout",
                    state: "in-progress",
                    startedAtMs: NOW - 8_000,
                    heartbeatAtMs: NOW - 7_000,
                    finishedAtMs: null,
                    errorJson: null,
                    metaJson: null,
                }),
                attemptRow({
                    runId: "edge-run",
                    nodeId: "retry-no-delay",
                    finishedAtMs: NOW - 2_000,
                    errorJson: null,
                    metaJson: "{bad json",
                }),
                attemptRow({
                    runId: "edge-run",
                    nodeId: "retry-no-delay",
                    attempt: 2,
                    finishedAtMs: NOW - 1_000,
                    errorJson: null,
                    metaJson: "{bad json",
                }),
                attemptRow({
                    runId: "edge-run",
                    nodeId: "no-finished",
                    startedAtMs: NOW - 10_000,
                    finishedAtMs: null,
                    errorJson: JSON.stringify({}),
                    metaJson: JSON.stringify({ retries: 0 }),
                }),
                attemptRow({
                    runId: "edge-run",
                    nodeId: "number-error",
                    errorJson: "42",
                    metaJson: JSON.stringify({ retries: 0 }),
                }),
            ],
        });

        const diagnosis = await diagnose(adapter, "edge-run");

        const approval = diagnosis.blockers.find((blocker) => blocker.kind === "waiting-approval");
        expect(approval?.waitingSince).toBe(NOW);
        expect(approval?.unblocker).toBe("smithers approve edge-run");

        const snapTimer = diagnosis.blockers.find((blocker) => blocker.nodeId === "snap-timer");
        expect(snapTimer?.context).toContain("Time remaining: 1d 1h");

        const emptyTimer = diagnosis.blockers.find((blocker) => blocker.nodeId === "empty-timer");
        expect(emptyTimer?.firesAtMs).toBe(null);
        expect(emptyTimer?.remainingMs).toBe(null);

        const metaTimeout = diagnosis.blockers.find((blocker) => blocker.nodeId === "meta-timeout");
        expect(metaTimeout?.reason).toContain("timeout: 1s");

        const retry = diagnosis.blockers.find((blocker) => blocker.kind === "retry-backoff");
        expect(retry?.context).toContain("Previous attempt failed (attempt 2).");
        expect(retry?.context).toContain("Retrying automatically");

        const failedReasons = diagnosis.blockers
            .filter((blocker) => blocker.kind === "retries-exhausted")
            .map((blocker) => blocker.reason);
        expect(failedReasons.some((reason) => reason.includes("{}"))).toBe(true);
        expect(failedReasons.some((reason) => reason.includes("42"))).toBe(true);
    });

    test("renders terminal summaries for non-blocked statuses", async () => {
        const finished = await diagnose(makeAdapter({
            run: runRow({
                status: "finished",
                finishedAtMs: NOW - 1_000,
                heartbeatAtMs: null,
            }),
        }));
        expect(renderWhyDiagnosisHuman(finished)).toBe("Run is finished, nothing is blocked.");

        const cancelled = await diagnose(makeAdapter({
            run: runRow({
                status: "cancelled",
                finishedAtMs: null,
                heartbeatAtMs: null,
            }),
        }));
        expect(cancelled.summary).toBe("Run was cancelled.");
        expect(renderWhyDiagnosisHuman(cancelled)).toBe("Run was cancelled.");

        const healthy = await diagnose(makeAdapter({
            nodes: [
                nodeRow({
                    nodeId: "older-pending",
                    state: "pending",
                    updatedAtMs: NOW - 5_000,
                }),
                nodeRow({
                    nodeId: "next-up",
                    state: "pending",
                    updatedAtMs: NOW - 2_000,
                }),
            ],
        }));
        expect(healthy.summary).toBe("Run is executing normally. Currently on node next-up.");
        expect(renderWhyDiagnosisHuman(healthy)).toBe(healthy.summary);

        const unknown = await diagnose(makeAdapter({
            run: runRow({
                status: undefined,
                heartbeatAtMs: null,
            }),
            nodes: null,
            approvals: null,
            attempts: null,
            events: null,
            lastSeq: null,
            lastFrame: { xmlJson: "not json" },
        }));
        expect(unknown.summary).toBe("Run is unknown. No blockers were identified.");
        expect(renderWhyDiagnosisHuman(unknown)).toContain("No blockers were identified.");
    });

    test("reports stale continued runs without a heartbeat", async () => {
        const diagnosis = await diagnose(makeAdapter({
            run: runRow({
                status: "continued",
                heartbeatAtMs: null,
            }),
            lastFrame: { xmlJson: JSON.stringify({ kind: "patch", value: [] }) },
        }));

        expect(diagnosis.status).toBe("running");
        expect(diagnosis.blockers).toHaveLength(1);
        expect(diagnosis.blockers[0]).toMatchObject({
            kind: "stale-heartbeat",
            nodeId: "(run-level)",
            reason: "Run appears orphaned (no heartbeat recorded)",
        });
        expect(renderWhyDiagnosisHuman(diagnosis)).toContain("Run appears orphaned");
    });

    test("fails with RUN_NOT_FOUND when adapter returns no run", async () => {
        const exit = await Effect.runPromiseExit(diagnoseRunEffect(makeAdapter({ run: undefined }), "missing-run", NOW));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
            throw new Error("expected diagnoseRunEffect to fail");
        }
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
            expect(failure.value.code).toBe("RUN_NOT_FOUND");
            expect(failure.value.summary).toBe("Run not found: missing-run");
        }
    });

    test("deduplicates and limits CTA commands", () => {
        const commands = diagnosisCtaCommands({
            runId: "cta-run",
            status: "running",
            summary: "Run cta-run is running",
            generatedAtMs: NOW,
            currentNodeId: null,
            blockers: [
                {
                    kind: "waiting-event",
                    nodeId: "unknown-signal",
                    iteration: 0,
                    waitingSince: NOW,
                    reason: "waiting",
                    unblocker: "smithers signal cta-run <signal-name>",
                },
                {
                    kind: "waiting-approval",
                    nodeId: "gate-a",
                    iteration: 0,
                    waitingSince: NOW,
                    reason: "waiting",
                    unblocker: "smithers approve cta-run",
                },
                {
                    kind: "waiting-approval",
                    nodeId: "gate-b",
                    iteration: 0,
                    waitingSince: NOW,
                    reason: "waiting",
                    unblocker: "smithers approve cta-run",
                },
                {
                    kind: "custom-kind",
                    nodeId: "custom",
                    iteration: 0,
                    waitingSince: NOW,
                    reason: "waiting",
                    unblocker: "custom-tool cta-run",
                },
                {
                    kind: "waiting-timer",
                    nodeId: "timer",
                    iteration: 0,
                    waitingSince: NOW,
                    reason: "waiting",
                    unblocker: "smithers up wf --run-id cta-run --resume true",
                },
                {
                    kind: "retry-backoff",
                    nodeId: "retry",
                    iteration: 0,
                    waitingSince: NOW,
                    reason: "waiting",
                    unblocker: "smithers retry-task wf --run-id cta-run --node-id retry --iteration 0",
                },
                {
                    kind: "stale-heartbeat",
                    nodeId: "(run-level)",
                    iteration: null,
                    waitingSince: NOW,
                    reason: "waiting",
                    unblocker: "smithers up wf --run-id cta-run --resume true --force true",
                },
                {
                    kind: "dependency-failed",
                    nodeId: "dep",
                    iteration: 0,
                    waitingSince: NOW,
                    reason: "waiting",
                    unblocker: "smithers up wf --run-id cta-run --resume true --ignored true",
                },
            ],
        });

        expect(commands).toHaveLength(7);
        expect(commands.map((entry) => entry.command)).toEqual([
            "approve cta-run",
            "custom-tool cta-run",
            "up wf --run-id cta-run --resume true",
            "retry-task wf --run-id cta-run --node-id retry --iteration 0",
            "up wf --run-id cta-run --resume true --force true",
            "inspect cta-run",
            "logs cta-run",
        ]);
        expect(commands[1].description).toBe("Unblock run");
    });
});
