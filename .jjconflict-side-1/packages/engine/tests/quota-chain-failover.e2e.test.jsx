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

const quotaError = (resetAtMs) =>
    new SmithersError("AGENT_QUOTA_EXCEEDED", "You've hit your usage limit.", {
        failureQuota: true,
        ...(resetAtMs != null ? { quotaResetAtMs: resetAtMs } : {}),
    });

describe("quota failover across an agent chain", () => {
    test("a rate-limited agent hands the task to the next agent in the chain instead of parking the run", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let primaryCalls = 0;
            let fallbackCalls = 0;
            const primary = {
                id: "primary",
                tools: {},
                async generate() {
                    primaryCalls += 1;
                    throw quotaError(Date.now() + 3_600_000);
                },
            };
            const fallback = {
                id: "fallback",
                tools: {},
                async generate() {
                    fallbackCalls += 1;
                    return { output: { value: 42 } };
                },
            };
            const workflow = smithers(() => (
                <Workflow name="quota-failover">
                    <Task id="q" output={outputs.outputA} agent={[primary, fallback]} retries={0}>
                        do the work on whichever provider is not rate-limited
                    </Task>
                </Workflow>
            ));
            const runId = "quota-failover-run";

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));

            expect(result.status).toBe("finished");
            expect(primaryCalls).toBe(1);
            expect(fallbackCalls).toBe(1);

            const run = await Effect.runPromise(adapter.getRun(runId));
            expect(run?.status).toBe("finished");
            const statuses = (await adapter.listEvents(runId, -1, 500))
                .filter((event) => event.type === "RunStatusChanged")
                .map((event) => JSON.parse(event.payloadJson).status);
            expect(statuses).not.toContain("waiting-quota");

            const rows = await db.select().from(tables.outputA);
            expect(rows.at(-1)?.value).toBe(42);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("the run only parks once EVERY agent in the chain is rate-limited, on the earliest reset", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const now = Date.now();
        const primaryResetAtMs = now + 3_600_000;
        const fallbackResetAtMs = now + 600_000;
        try {
            let primaryCalls = 0;
            let fallbackCalls = 0;
            const primary = {
                id: "primary",
                tools: {},
                async generate() {
                    primaryCalls += 1;
                    if (primaryCalls === 1) throw quotaError(primaryResetAtMs);
                    return { output: { value: primaryCalls } };
                },
            };
            const fallback = {
                id: "fallback",
                tools: {},
                async generate() {
                    fallbackCalls += 1;
                    throw quotaError(fallbackResetAtMs);
                },
            };
            const workflow = smithers(() => (
                <Workflow name="quota-all-blocked">
                    <Task id="q" output={outputs.outputA} agent={[primary, fallback]} retries={0}>
                        every provider is rate-limited
                    </Task>
                </Workflow>
            ));
            const runId = "quota-all-blocked-run";

            const parked = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(parked.status).toBe("waiting-quota");
            expect(primaryCalls).toBe(1);
            expect(fallbackCalls).toBe(1);

            const run = await Effect.runPromise(adapter.getRun(runId));
            expect(run?.status).toBe("waiting-quota");
            const quotaMeta = JSON.parse(run?.errorJson ?? "null");
            expect(quotaMeta?.quotaBlockedCount).toBe(1);
            // The soonest provider to free up, not the last one that failed.
            expect(quotaMeta?.resetAtMs).toBe(fallbackResetAtMs);

            // Resuming starts a fresh failover round at the head of the chain
            // instead of ping-ponging between the two blocked providers.
            const resumed = await Effect.runPromise(
                runWorkflow(workflow, { input: {}, runId, resume: true }),
            );
            expect(resumed.status).toBe("finished");
            expect(primaryCalls).toBe(2);
            expect(fallbackCalls).toBe(1);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("failing over on a rate limit does not consume the task's retry budget", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        try {
            let fallbackCalls = 0;
            const primary = {
                id: "primary",
                tools: {},
                async generate() {
                    throw quotaError(Date.now() + 3_600_000);
                },
            };
            const fallback = {
                id: "fallback",
                tools: {},
                async generate() {
                    fallbackCalls += 1;
                    // Burns the one retry the task is allowed, then succeeds.
                    if (fallbackCalls === 1) throw new Error("ordinary provider timeout");
                    return { output: { value: fallbackCalls } };
                },
            };
            const workflow = smithers(() => (
                <Workflow name="quota-failover-retries">
                    <Task id="q" output={outputs.outputA} agent={[primary, fallback]} retries={1}>
                        the quota attempt must not eat the retry
                    </Task>
                </Workflow>
            ));
            const runId = "quota-failover-retries-run";

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
            expect(result.status).toBe("finished");
            expect(fallbackCalls).toBe(2);
            const attempts = await adapter.listAttempts(runId, "q", 0);
            expect(attempts).toHaveLength(3);
        } finally {
            cleanup();
        }
    }, TIMEOUT_MS);
});
