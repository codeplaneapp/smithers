/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { HumanTask, Workflow, runWorkflow } from "smithers-orchestrator";
import { approveNode } from "../src/approvals.js";
import { buildHumanRequestId } from "../src/human-requests.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
/**
 * @param {any} workflow
 * @param {string} dbPath
 * @param {any} opts
 */
function runInTestRoot(workflow, dbPath, opts) {
    return Effect.runPromise(runWorkflow(workflow, {
        ...opts,
        rootDir: dirname(dbPath),
    }));
}
describe("<HumanTask> cancellation", () => {
    test("a cancelled request fails the run with HUMAN_TASK_CANCELLED and is never reopened", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
            review: z.object({ score: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="human-cancel">
        <HumanTask id="review" output={outputs.review} prompt="Score it" maxAttempts={1}/>
      </Workflow>));
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            const requestId = buildHumanRequestId(first.runId, "review", 0);
            await adapter.cancelHumanRequest(requestId);
            expect((await adapter.getHumanRequest(requestId))?.status).toBe("cancelled");
            // Even an operator approval cannot resurrect a cancelled request.
            await Effect.runPromise(approveNode(adapter, first.runId, "review", 0, undefined, "ops"));
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            expect(resumed.status).toBe("failed");
            const attempts = await Effect.runPromise(adapter.listAttempts(first.runId, "review", 0));
            expect(attempts).toHaveLength(1);
            expect(JSON.parse(attempts[0]?.errorJson ?? "{}").code).toBe("HUMAN_TASK_CANCELLED");
            // Unlike a schema-validation failure, cancellation is terminal: a
            // further resume must not flip the request back to pending.
            const again = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            expect(again.status).toBe("failed");
            expect((await adapter.getHumanRequest(requestId))?.status).toBe("cancelled");
        }
        finally {
            cleanup();
        }
    });
});
