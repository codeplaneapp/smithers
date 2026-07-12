/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Task } from "../../components/src/components/Task.js";
import { Workflow } from "../../components/src/components/Workflow.js";
import { runWorkflow } from "../src/engine.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

const TIMEOUT_MS = 30_000;

describe("quota-aware park lifecycle e2e", () => {
    test("a latest quota failure parks even after a non-quota failure exhausted retries, then resumes", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let calls = 0;
            const agent = {
                id: "mixed-failure-agent",
                tools: {},
                async generate() {
                    calls += 1;
                    if (calls === 1) {
                        throw new Error("ordinary provider timeout");
                    }
                    if (calls === 2) {
                        throw new SmithersError("AGENT_QUOTA_EXCEEDED", "usage window exhausted", {
                            failureQuota: true,
                            quotaResetAtMs: Date.now() + 60_000,
                        });
                    }
                    return { output: { value: calls } };
                },
            };
            const workflow = smithers(() => (
                <Workflow name="mixed-failure-quota-park">
                    <Task id="q" output={outputs.outputA} agent={agent} retries={calls < 2 ? 1 : 0}>
                        fail normally, then hit quota
                    </Task>
                </Workflow>
            ));
            const runId = "mixed-failure-quota-park-run";

            const parked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(parked.status).toBe("waiting-quota");
            expect((await adapter.getRun(runId))?.status).toBe("waiting-quota");

            const resumed = await Effect.runPromise(
                runWorkflow(workflow, { input: {}, runId, resume: true }),
            );
            expect(resumed.status).toBe("finished");
            expect(calls).toBe(3);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("quota failure parks the run as waiting-quota with reset metadata and preserves the retry budget", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const resetAtMs = Date.now() + 60_000;
        try {
            let calls = 0;
            const agent = {
                id: "quota-agent",
                tools: {},
                async generate() {
                    calls += 1;
                    if (calls === 1) {
                        throw new SmithersError(
                            "AGENT_QUOTA_EXCEEDED",
                            "You've hit your usage limit.",
                            { failureQuota: true, quotaResetAtMs: resetAtMs },
                        );
                    }
                    return { output: { value: calls } };
                },
            };
            // retries={0}: if the quota attempt consumed retry budget, the
            // resumed run could never re-execute the task.
            const workflow = smithers(() => (
                <Workflow name="quota-park">
                    <Task id="q" output={outputs.outputA} agent={agent} retries={0}>
                        hit quota once
                    </Task>
                </Workflow>
            ));
            const runId = "quota-park-run";
            const parked = await Effect.runPromise(
                runWorkflow(workflow, { input: {}, runId }),
            );
            expect(parked.status).toBe("waiting-quota");

            const run = await Effect.runPromise(adapter.getRun(runId));
            expect(run?.status).toBe("waiting-quota");
            expect(run?.runtimeOwnerId).toBeNull();
            expect(run?.heartbeatAtMs).toBeNull();
            const quotaMeta = JSON.parse(run?.errorJson ?? "null");
            expect(quotaMeta?.quotaBlockedCount).toBe(1);
            expect(quotaMeta?.resetAtMs).toBe(resetAtMs);

            const events = await adapter.listEvents(runId, -1, 200);
            const statusChanges = events
                .filter((event) => event.type === "RunStatusChanged")
                .map((event) => JSON.parse(event.payloadJson));
            expect(
                statusChanges.some((payload) => payload.status === "waiting-quota"),
            ).toBe(true);

            const resumed = await Effect.runPromise(
                runWorkflow(workflow, { input: {}, runId, resume: true }),
            );
            expect(resumed.status).toBe("finished");
            expect(calls).toBe(2);
            const attempts = await adapter.listAttempts(runId, "q", 0);
            expect(attempts).toHaveLength(2);

            const finalRun = await Effect.runPromise(adapter.getRun(runId));
            expect(finalRun?.status).toBe("finished");
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("a quota block does NOT demote the task down the agent failover chain: it retries on the SAME agent, not the fallback", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let primaryCalls = 0;
            let fallbackCalls = 0;
            // The agent the user actually chose (think: Codex sol/luna).
            const primary = {
                id: "primary",
                tools: {},
                async generate() {
                    primaryCalls += 1;
                    if (primaryCalls === 1) {
                        throw new SmithersError("AGENT_QUOTA_EXCEEDED", "You've hit your usage limit.", {
                            failureQuota: true,
                            quotaResetAtMs: Date.now() + 60_000,
                        });
                    }
                    return { output: { value: primaryCalls } };
                },
            };
            // The failover rung behind it (think: the Claude fallback).
            const fallback = {
                id: "fallback",
                tools: {},
                async generate() {
                    fallbackCalls += 1;
                    return { output: { value: -1 } };
                },
            };
            // Chain rung is derived from the attempt number. A quota attempt must be
            // discounted, or the quota wall silently moves every task onto `fallback`
            // for the rest of the run even after the quota resets.
            const workflow = smithers(() => (
                <Workflow name="quota-no-demote">
                    <Task id="q" output={outputs.outputA} agent={[primary, fallback]}>
                        do the work on the chosen agent
                    </Task>
                </Workflow>
            ));
            const runId = "quota-no-demote-run";

            const parked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(parked.status).toBe("waiting-quota");

            const resumed = await Effect.runPromise(
                runWorkflow(workflow, { input: {}, runId, resume: true }),
            );
            expect(resumed.status).toBe("finished");

            // The retry went back to the PRIMARY, not down the chain.
            expect(primaryCalls).toBe(2);
            expect(fallbackCalls).toBe(0);
            const rows = await db.select().from(tables.outputA);
            expect(rows.at(-1)?.value).toBe(2);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("failureQuota detail flag on a non-quota code also parks instead of failing", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let calls = 0;
            const agent = {
                id: "quota-flag-agent",
                tools: {},
                async generate() {
                    calls += 1;
                    if (calls === 1) {
                        throw new SmithersError("AGENT_CLI_ERROR", "rate limit exceeded", {
                            failureQuota: true,
                        });
                    }
                    return { output: { value: calls } };
                },
            };
            const workflow = smithers(() => (
                <Workflow name="quota-flag-park">
                    <Task id="q" output={outputs.outputA} agent={agent} noRetry>
                        quota via detail flag
                    </Task>
                </Workflow>
            ));
            const runId = "quota-flag-park-run";
            const parked = await Effect.runPromise(
                runWorkflow(workflow, { input: {}, runId }),
            );
            expect(parked.status).toBe("waiting-quota");
            const run = await Effect.runPromise(adapter.getRun(runId));
            const quotaMeta = JSON.parse(run?.errorJson ?? "null");
            expect(quotaMeta?.quotaBlockedCount).toBe(1);
            // No reset time provided — the metadata must omit it, not invent one.
            expect(quotaMeta?.resetAtMs).toBeUndefined();

            const resumed = await Effect.runPromise(
                runWorkflow(workflow, { input: {}, runId, resume: true }),
            );
            expect(resumed.status).toBe("finished");
            expect(calls).toBe(2);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);
});
