/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { HumanTask } from "@smithers-orchestrator/components/components/index";
import { SmithersDb, Workflow, runWorkflow } from "smithers-orchestrator";
import { buildHumanRequestId } from "../src/human-requests.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

describe("HumanTask maxAttempts bounds", () => {
    test("rejects non-finite maxAttempts before creating durable human retry state", async () => {
        const runId = "human-task-infinite-max-attempts";
        const { smithers, outputs, db, cleanup } = createTestSmithers({
            review: z.object({ approved: z.boolean() }),
        });
        try {
            const workflow = smithers(() => (
                <Workflow name="human-task-infinite-max-attempts">
                    <HumanTask
                        id="review"
                        output={outputs.review}
                        prompt="Review the release checklist as JSON."
                        maxAttempts={Number.POSITIVE_INFINITY}
                    />
                </Workflow>
            ));

            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));

            expect(result.status).toBe("failed");
            expect(result.error?.code).toBe("INVALID_INPUT");
            expect(result.error?.message).toContain("maxAttempts");

            const adapter = new SmithersDb(db);
            const requestId = buildHumanRequestId(runId, "review", 0);
            expect(await adapter.getHumanRequest(requestId)).toBeUndefined();
            expect(await adapter.getApproval(runId, "review", 0)).toBeUndefined();
            expect(await adapter.listAttempts(runId, "review", 0)).toHaveLength(0);

            const run = await adapter.getRun(runId);
            const persistedError = JSON.parse(run?.errorJson ?? "{}");
            expect(run?.status).toBe("failed");
            expect(persistedError.code).toBe("INVALID_INPUT");
        }
        finally {
            cleanup();
        }
    });
});
