/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb, Task, Workflow, defineTool, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { __engineInternals } from "../src/engine.js";
import { approveNode, denyNode } from "../src/approvals.js";
import { archiveDiscardedEffects } from "../../time-travel/src/archiveDiscardedEffects.js";

const TIMEOUT_MS = 20_000;

function deferred() {
    let resolve;
    const promise = new Promise((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

async function waitForRow(adapter, runId, nodeId) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await Effect.runPromise(adapter.listToolCalls(runId, nodeId, 0));
        if (rows.length > 0) return rows[0];
        await Bun.sleep(5);
    }
    throw new Error(`Timed out waiting for effect row ${runId}/${nodeId}`);
}

async function replaceArchivedCallWithFreshPrimaryKey(adapter, row, opId) {
    await archiveDiscardedEffects(adapter, {
        runId: row.runId,
        opId,
        archivedAtMs: Date.now(),
        archiveReason: "rewind",
        attempts: [{
            nodeId: row.nodeId,
            iteration: row.iteration,
            attempt: row.attempt,
        }],
    });
    const freshCallToken = crypto.randomUUID();
    await Effect.runPromise(adapter.insertToolCall({
        ...row,
        callToken: freshCallToken,
        inputJson: '{"generation":"fresh"}',
        outputJson: null,
        startedAtMs: Date.now(),
        finishedAtMs: null,
        status: "intended",
        errorJson: null,
        revertStatus: null,
        revertedAtMs: null,
        revertErrorJson: null,
        forcedPastJson: null,
    }));
    return freshCallToken;
}

function createFixture(render) {
    const fixture = createTestSmithers({ result: z.object({ value: z.number() }) });
    return {
        ...fixture,
        workflow: fixture.smithers(() => <Workflow name="effect-journal">{render(fixture.outputs.result)}</Workflow>),
    };
}

describe("side-effect journal lifecycle", () => {
    test("tool rows move intended -> succeeded and persist call-time provenance", async () => {
        const release = deferred();
        const entered = deferred();
        const revert = async () => {};
        const effectTool = defineTool({
            name: "publish-message",
            schema: z.object({}),
            sideEffect: true,
            idempotent: false,
            execute: async (_args, _ctx) => {
                entered.resolve();
                await release.promise;
                return { messageId: "m-1" };
            },
            revert,
        });
        const agent = {
            tools: { publish: effectTool },
            async generate() {
                await effectTool.execute({}, {});
                return { output: { value: 1 } };
            },
        };
        const fixture = createFixture((output) => <Task id="publish" output={output} agent={agent} retries={0}>Publish.</Task>);
        const adapter = new SmithersDb(fixture.db);
        const runId = "tool-effect-run";
        try {
            const running = Effect.runPromise(runWorkflow(fixture.workflow, { input: {}, runId }));
            await entered.promise;
            expect(await waitForRow(adapter, runId, "publish")).toMatchObject({
                kind: "tool",
                toolName: "publish-message",
                status: "intended",
                sideEffect: true,
                idempotent: false,
                acceptsIdempotencyKey: true,
                hasRevert: true,
                idempotencyKey: `smithers:${runId}:publish:0`,
            });
            release.resolve();
            expect((await running).status).toBe("finished");
            expect((await Effect.runPromise(adapter.listToolCalls(runId, "publish", 0)))[0]).toMatchObject({
                status: "succeeded",
                outputJson: '{"messageId":"m-1"}',
            });
        }
        finally {
            release.resolve();
            fixture.cleanup();
        }
    }, TIMEOUT_MS);

    test("tool failures journal unknown", async () => {
        const effectTool = defineTool({
            name: "uncertain-send",
            schema: z.object({}),
            sideEffect: true,
            idempotent: false,
            execute: async (_args, _ctx) => {
                throw new Error("connection dropped after send");
            },
        });
        const agent = {
            tools: { send: effectTool },
            async generate() {
                await effectTool.execute({}, {});
                return { output: { value: 1 } };
            },
        };
        const fixture = createFixture((output) => <Task id="send" output={output} agent={agent} retries={0}>Send.</Task>);
        try {
            const result = await Effect.runPromise(runWorkflow(fixture.workflow, { input: {}, runId: "tool-fail-run" }));
            expect(result.status).toBe("failed");
            const rows = await Effect.runPromise(new SmithersDb(fixture.db).listToolCalls(result.runId, "send", 0));
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                kind: "tool",
                status: "unknown",
                sideEffect: true,
                errorJson: expect.stringContaining("connection dropped after send"),
            });
        }
        finally {
            fixture.cleanup();
        }
    }, TIMEOUT_MS);

    test("canonical agent late completion is token-fenced after primary-key reuse", async () => {
        const release = deferred();
        const entered = deferred();
        let staleCompletion;
        let receivedSignal;
        const effectTool = defineTool({
            name: "canonical-agent-late",
            schema: z.object({}),
            sideEffect: true,
            idempotent: false,
            execute: async (_args, context) => {
                receivedSignal = context.signal;
                entered.resolve();
                await release.promise;
                return { generation: "stale" };
            },
        });
        const agent = {
            tools: { publish: effectTool },
            async generate() {
                staleCompletion = effectTool.execute({});
                await entered.promise;
                throw new Error("agent failed while tool remained in flight");
            },
        };
        const fixture = createFixture((output) => (
            <Task id="canonical-agent-late" output={output} agent={agent} retries={0}>
                Publish.
            </Task>
        ));
        const adapter = new SmithersDb(fixture.db);
        const runId = "canonical-agent-late-run";
        try {
            expect((await Effect.runPromise(runWorkflow(fixture.workflow, {
                input: {},
                runId,
            }))).status).toBe("failed");
            expect(receivedSignal).toBeInstanceOf(AbortSignal);
            const staleRow = (await Effect.runPromise(
                adapter.listToolCalls(runId, "canonical-agent-late", 0),
            )).find((row) => row.toolName === "canonical-agent-late");
            const staleCallToken = String(staleRow.callToken);
            expect(staleRow).toMatchObject({ status: "unknown", callToken: expect.any(String) });
            const freshCallToken = await replaceArchivedCallWithFreshPrimaryKey(
                adapter,
                staleRow,
                "canonical-agent-rewind",
            );
            expect(await adapter.internalStorage.queryOne(
                `SELECT call_token, status FROM _smithers_tool_call_archive WHERE call_token = ?`,
                [staleCallToken],
            )).toEqual({ callToken: staleCallToken, status: "unknown" });

            release.resolve();
            await staleCompletion;

            expect(await adapter.internalStorage.queryOne(
                `SELECT status, output_json FROM _smithers_tool_calls WHERE call_token = ?`,
                [freshCallToken],
            )).toEqual({ status: "intended", outputJson: null });
            expect(await adapter.internalStorage.queryOne(
                `SELECT status, output_json FROM _smithers_tool_call_archive WHERE call_token = ?`,
                [staleCallToken],
            )).toEqual({ status: "succeeded", outputJson: '{"generation":"stale"}' });
            expect(await Effect.runPromise(
                adapter.listEventsByType(runId, "SideEffectBoundaryCrossed"),
            )).toHaveLength(1);
        }
        finally {
            release.resolve();
            await staleCompletion?.catch(() => undefined);
            fixture.cleanup();
        }
    }, TIMEOUT_MS);

    test("canonical compute late completion is token-fenced after primary-key reuse", async () => {
        const release = deferred();
        const entered = deferred();
        let staleCompletion;
        let receivedSignal;
        const effectTool = defineTool({
            name: "canonical-compute-late-tool",
            schema: z.object({}),
            sideEffect: true,
            idempotent: false,
            execute: async (_args, context) => {
                receivedSignal = context.signal;
                entered.resolve();
                await release.promise;
                return { generation: "stale" };
            },
        });
        const fixture = createFixture((output) => (
            <Task
                id="canonical-compute-late"
                output={output}
                retries={0}
                sideEffect={{ idempotent: false }}
            >
                {async () => {
                    staleCompletion = effectTool.execute({});
                    await entered.promise;
                    throw new Error("compute failed while tool remained in flight");
                }}
            </Task>
        ));
        const adapter = new SmithersDb(fixture.db);
        const runId = "canonical-compute-late-run";
        try {
            expect((await Effect.runPromise(runWorkflow(fixture.workflow, {
                input: {},
                runId,
            }))).status).toBe("failed");
            expect(receivedSignal).toBeInstanceOf(AbortSignal);
            const staleRow = (await Effect.runPromise(
                adapter.listToolCalls(runId, "canonical-compute-late", 0),
            )).find((row) => row.toolName === "canonical-compute-late-tool");
            const staleCallToken = String(staleRow.callToken);
            expect(staleRow).toMatchObject({ status: "unknown", callToken: expect.any(String) });
            const freshCallToken = await replaceArchivedCallWithFreshPrimaryKey(
                adapter,
                staleRow,
                "canonical-compute-rewind",
            );

            release.resolve();
            await staleCompletion;

            expect(await adapter.internalStorage.queryOne(
                `SELECT status, output_json FROM _smithers_tool_calls WHERE call_token = ?`,
                [freshCallToken],
            )).toEqual({ status: "intended", outputJson: null });
            expect(await adapter.internalStorage.queryOne(
                `SELECT status, output_json FROM _smithers_tool_call_archive WHERE call_token = ?`,
                [staleCallToken],
            )).toEqual({ status: "succeeded", outputJson: '{"generation":"stale"}' });
            expect(await Effect.runPromise(
                adapter.listEventsByType(runId, "SideEffectBoundaryCrossed"),
            )).toHaveLength(1);
        }
        finally {
            release.resolve();
            await staleCompletion?.catch(() => undefined);
            fixture.cleanup();
        }
    }, TIMEOUT_MS);

    test("compute tools are journaled and block replay before a second side effect", async () => {
        let invocations = 0;
        const computeTool = defineTool({
            name: "compute-publish",
            schema: z.object({}),
            sideEffect: true,
            idempotent: false,
            execute: async () => {
                invocations += 1;
                return { published: true };
            },
        });
        const fixture = createFixture((output) => (
            <Task id="compute-tool" output={output} retries={1} retryPolicy={{ backoff: "fixed", initialDelayMs: 0 }}>
                {async () => {
                    await computeTool.execute({});
                    throw new Error("failed after compute tool effect");
                }}
            </Task>
        ));
        try {
            const result = await Effect.runPromise(runWorkflow(fixture.workflow, {
                input: {},
                runId: "compute-tool-journal",
            }));
            expect(result.status).toBe("waiting-approval");
            expect(invocations).toBe(1);

            const adapter = new SmithersDb(fixture.db);
            const rows = await Effect.runPromise(adapter.listToolCalls(
                result.runId,
                "compute-tool",
                0,
            ));
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                kind: "tool",
                toolName: "compute-publish",
                status: "succeeded",
                sideEffect: true,
                idempotent: false,
                acceptsIdempotencyKey: false,
                hasRevert: false,
            });
            const approval = await Effect.runPromise(adapter.getApproval(
                result.runId,
                "compute-tool",
                0,
            ));
            expect(JSON.parse(approval?.requestJson ?? "{}")).toMatchObject({
                kind: "ReplayUnsafeApproval",
                offending: [{
                    kind: "tool",
                    toolName: "compute-publish",
                    attempt: 1,
                    seq: 1,
                }],
            });
        }
        finally {
            fixture.cleanup();
        }
    }, TIMEOUT_MS);

    test.each([
        ["approved", true],
        ["denied", false],
    ])("compute replay consumes a later negative-iteration approval when %s", async (_label, approved) => {
        let invocations = 0;
        const computeTool = defineTool({
            name: `compute-multi-approval-${approved ? "approved" : "denied"}`,
            schema: z.object({}),
            sideEffect: true,
            idempotent: false,
            execute: async () => {
                invocations += 1;
                return { invocation: invocations };
            },
        });
        const fixture = createFixture((output) => (
            <Task id="compute-multi-approval" output={output} retries={2} retryPolicy={{ backoff: "fixed", initialDelayMs: 0 }}>
                {async () => {
                    await computeTool.execute({});
                    if (invocations <= 2) {
                        throw new Error(`failed after compute effect ${invocations}`);
                    }
                    return { value: invocations };
                }}
            </Task>
        ));
        const adapter = new SmithersDb(fixture.db);
        try {
            const first = await Effect.runPromise(runWorkflow(fixture.workflow, {
                input: {},
                runId: `compute-multi-approval-${approved ? "approved" : "denied"}`,
            }));
            expect(first.status).toBe("waiting-approval");
            await Effect.runPromise(approveNode(
                adapter,
                first.runId,
                "compute-multi-approval",
                0,
                "allow first replay",
                "operator",
            ));

            const second = await Effect.runPromise(runWorkflow(fixture.workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(second.status).toBe("waiting-approval");
            expect(invocations).toBe(2);
            const pending = await Effect.runPromise(adapter.listPendingApprovals(first.runId));
            expect(pending).toHaveLength(1);
            expect(pending[0].iteration).toBeLessThan(0);

            const decide = approved ? approveNode : denyNode;
            await Effect.runPromise(decide(
                adapter,
                first.runId,
                "compute-multi-approval",
                0,
                approved ? "allow second replay" : "stop second replay",
                "operator",
            ));
            const decided = await Effect.runPromise(runWorkflow(fixture.workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(decided.status).toBe(approved ? "finished" : "failed");
            expect(invocations).toBe(approved ? 3 : 2);
            expect((await Effect.runPromise(
                adapter.getApproval(first.runId, "compute-multi-approval", pending[0].iteration),
            ))?.status).toBe(approved ? "approved" : "denied");
            expect(await Effect.runPromise(
                adapter.listEventsByType(first.runId, "ApprovalRequested"),
            )).toHaveLength(2);

            const resumedAgain = await Effect.runPromise(runWorkflow(fixture.workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumedAgain.status).toBe(approved ? "finished" : "failed");
            expect(invocations).toBe(approved ? 3 : 2);
            expect(await Effect.runPromise(
                adapter.listEventsByType(first.runId, "ApprovalRequested"),
            )).toHaveLength(2);
        }
        finally {
            fixture.cleanup();
        }
    }, TIMEOUT_MS);

    test("task rows move intended -> succeeded and journal the output row", async () => {
        const release = deferred();
        const entered = deferred();
        const revert = async () => {};
        const fixture = createFixture((output) => (
            <Task id="compute-effect" output={output} retries={0} sideEffect={{ idempotent: false, revert }}>
                {async () => {
                    entered.resolve();
                    await release.promise;
                    return { value: 2 };
                }}
            </Task>
        ));
        const adapter = new SmithersDb(fixture.db);
        const runId = "task-effect-run";
        try {
            const running = Effect.runPromise(runWorkflow(fixture.workflow, { input: {}, runId }));
            await entered.promise;
            expect(await waitForRow(adapter, runId, "compute-effect")).toMatchObject({
                kind: "task",
                toolName: "compute-effect",
                seq: 0,
                status: "intended",
                sideEffect: true,
                idempotent: false,
                acceptsIdempotencyKey: false,
                hasRevert: true,
                idempotencyKey: null,
            });
            release.resolve();
            expect((await running).status).toBe("finished");
            const row = (await Effect.runPromise(adapter.listToolCalls(runId, "compute-effect", 0)))[0];
            expect(row.status).toBe("succeeded");
            expect(JSON.parse(row.outputJson)).toMatchObject({
                runId,
                nodeId: "compute-effect",
                iteration: 0,
                value: 2,
            });
        }
        finally {
            release.resolve();
            fixture.cleanup();
        }
    }, TIMEOUT_MS);

    test("task failures journal unknown", async () => {
        const fixture = createFixture((output) => (
            <Task id="task-fail" output={output} retries={0} sideEffect>
                {async () => {
                    throw new Error("effect outcome unclear");
                }}
            </Task>
        ));
        try {
            const result = await Effect.runPromise(runWorkflow(fixture.workflow, { input: {}, runId: "task-fail-run" }));
            expect(result.status).toBe("failed");
            const rows = await Effect.runPromise(new SmithersDb(fixture.db).listToolCalls(result.runId, "task-fail", 0));
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                kind: "task",
                seq: 0,
                status: "unknown",
                sideEffect: true,
                errorJson: expect.stringContaining("effect outcome unclear"),
            });
        }
        finally {
            fixture.cleanup();
        }
    }, TIMEOUT_MS);

    test.each(["tool", "task"])("crash recovery collapses intended %s rows to unknown", async (kind) => {
        const fixture = createFixture((output) => <Task id="crashed" output={output}>{{ value: 1 }}</Task>);
        const adapter = new SmithersDb(fixture.db);
        const runId = `crashed-${kind}`;
        try {
            await Effect.runPromise(adapter.insertRun({
                runId,
                parentRunId: null,
                workflowName: "effect-journal",
                workflowPath: null,
                workflowHash: null,
                status: "running",
                createdAtMs: 1,
                startedAtMs: 1,
                finishedAtMs: null,
                heartbeatAtMs: 1,
                runtimeOwnerId: null,
                cancelRequestedAtMs: null,
                pauseRequestedAtMs: null,
                hijackRequestedAtMs: null,
                hijackTarget: null,
                vcsType: null,
                vcsRoot: null,
                vcsRevision: null,
                errorJson: null,
                configJson: null,
            }));
            await Effect.runPromise(adapter.insertAttempt({
                runId,
                nodeId: "crashed",
                iteration: 0,
                attempt: 1,
                state: "in-progress",
                startedAtMs: 1,
                finishedAtMs: null,
                heartbeatAtMs: null,
                heartbeatDataJson: null,
                errorJson: null,
                jjPointer: null,
                jjCwd: null,
                cached: false,
                metaJson: null,
            }));
            await Effect.runPromise(adapter.insertNode({
                runId,
                nodeId: "crashed",
                iteration: 0,
                state: "in-progress",
                lastAttempt: 1,
                updatedAtMs: 1,
                outputTable: "result",
                label: null,
            }));
            await Effect.runPromise(adapter.insertToolCall({
                runId,
                nodeId: "crashed",
                iteration: 0,
                attempt: 1,
                seq: kind === "task" ? 0 : 1,
                toolName: kind === "task" ? "crashed" : "send",
                inputJson: null,
                outputJson: null,
                startedAtMs: 1,
                finishedAtMs: null,
                status: "intended",
                errorJson: null,
                kind,
                sideEffect: true,
                idempotent: false,
                acceptsIdempotencyKey: false,
                hasRevert: false,
                idempotencyKey: null,
                revertStatus: null,
                revertedAtMs: null,
                revertErrorJson: null,
                forcedPastJson: null,
            }));

            await __engineInternals.cancelStaleAttempts(adapter, runId);
            expect((await Effect.runPromise(adapter.listToolCalls(runId, "crashed", 0)))[0]).toMatchObject({
                kind,
                status: "unknown",
                finishedAtMs: expect.any(Number),
            });
        }
        finally {
            fixture.cleanup();
        }
    }, TIMEOUT_MS);
});
