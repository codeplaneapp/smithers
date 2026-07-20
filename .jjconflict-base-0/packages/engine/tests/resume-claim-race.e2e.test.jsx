/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkflow, Timer, Workflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

// Engine-level coverage for the "two processes race to resume the same
// crashed/parked run" safety property (RUN_RESUME_CLAIM_OWNERSHIP). The
// underlying compare-and-swap primitive is already unit-tested at the DB
// layer (packages/db/tests/db-adapter.test.js), and the resumeClaim
// handoff path is covered by packages/engine/tests/durability.test.jsx.
// What's untested is activateRunForResume's own guards when driven through
// the real public runWorkflow() API with no pre-existing claim.
describe("resume claim race safety", () => {
    /**
     * @returns {{ dir: string; workflowPath: string }}
     */
    function writeTimerWorkflow() {
        const dir = mkdtempSync(join(tmpdir(), "smithers-resume-race-"));
        const workflowPath = join(dir, "workflow.tsx");
        writeFileSync(workflowPath, "export default 'v1';\n", "utf8");
        return { dir, workflowPath };
    }

    test("resuming a live 'running' run without force is rejected and does not clobber the owner", async () => {
        const { dir, workflowPath } = writeTimerWorkflow();
        const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const runId = "resume-still-running";
        const workflow = smithers(() => (<Workflow name="resume-still-running">
        <Timer id="hold" duration="1h"/>
      </Workflow>));
        try {
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, workflowPath }));
            expect(first.status).toBe("waiting-timer");

            // Simulate another live process actively owning the run right now
            // (fresh heartbeat, no runtimeOwnerId so the RUN_OWNER_ALIVE pid
            // check is bypassed and the plain heartbeat-freshness guard fires).
            const heartbeatAtMs = nowMs();
            await Effect.runPromise(adapter.updateRun(runId, {
                status: "running",
                runtimeOwnerId: null,
                heartbeatAtMs,
            }));

            const blocked = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
                workflowPath,
            }));
            expect(blocked.status).toBe("failed");
            expect(blocked.error?.code).toBe("RUN_STILL_RUNNING");

            // The losing attempt must not have mutated the row it failed to claim.
            const untouched = await adapter.getRun(runId);
            expect(untouched?.status).toBe("running");
            expect(untouched?.heartbeatAtMs).toBe(heartbeatAtMs);
            expect(untouched?.runtimeOwnerId).toBeNull();

            // force:true overrides the freshness guard and actually resumes.
            const forced = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
                force: true,
                workflowPath,
            }));
            expect(forced.status).not.toBe("failed");
            expect(forced.status).toBe("waiting-timer");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
            cleanup();
        }
    });

    test("two concurrent resume attempts on the same parked run: at most one wins", async () => {
        const { dir, workflowPath } = writeTimerWorkflow();
        const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
        const adapter = new SmithersDb(db);
        const runId = "resume-concurrent-race";
        const workflow = smithers(() => (<Workflow name="resume-concurrent-race">
        <Timer id="hold" duration="1h"/>
      </Workflow>));
        try {
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, workflowPath }));
            expect(first.status).toBe("waiting-timer");

            const attempt = () => Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId,
                resume: true,
                force: true,
                workflowPath,
            }));
            const [a, b] = await Promise.all([attempt(), attempt()]);

            const succeeded = [a, b].filter((result) => result.status !== "failed");
            const failed = [a, b].filter((result) => result.status === "failed");
            // The exact interleaving is timing-dependent, but the safety
            // property that must always hold is that the two processes never
            // both believe they own the run at once.
            expect(succeeded.length).toBeLessThanOrEqual(1);
            for (const result of failed) {
                expect([
                    "RUN_RESUME_CLAIM_FAILED",
                    "RUN_RESUME_ACTIVATION_FAILED",
                    "RUN_STILL_RUNNING",
                    // The winner's runtimeOwnerId embeds this test process's own
                    // real pid, so a loser reading post-activation state sees a
                    // live owner and is rejected via the RUN_OWNER_ALIVE guard.
                    "RUN_OWNER_ALIVE",
                ]).toContain(result.error?.code);
            }

            // The run must end up in a coherent, non-corrupted state: owned by
            // exactly whichever attempt (if any) actually won.
            const finalRun = await adapter.getRun(runId);
            expect(finalRun).not.toBeNull();
            if (succeeded.length === 1) {
                expect(finalRun?.status).toBe("waiting-timer");
            }
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
            cleanup();
        }
    });
});
